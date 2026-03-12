require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const Parser = require("rss-parser");
const slugify = require("slugify");
const { OpenAI } = require("openai");
const { Resend } = require('resend'); 

// --- 1. INICIALIZACIÓN DE CLIENTES ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const parser = new Parser({
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  },
});

// --- 2. CONFIGURACIÓN DE BOLETINES ---
const FUENTES_BOLETINES = [
  // 🟢 BOLETINES CON RSS FUNCIONAL
  { nombre: "BOE", tipo: "rss", url: "https://www.boe.es/rss/boe.php?s=2B", ambito: "Estatal" },
  { nombre: "BOJA", tipo: "rss", url: "https://www.juntadeandalucia.es/boja/distribucion/s52.xml", ambito: "Andalucía" },
  { nombre: "BOCM", tipo: "rss", url: "https://www.bocm.es/rss", ambito: "Madrid" },
  { nombre: "DOG", tipo: "rss", url: "https://www.xunta.gal/diario-oficial-galicia/rss/2.xml", ambito: "Galicia" },

  // 🌐 BOLETINES SIN RSS (Rastreo de Sumarios HTML vía Cloudflare)
  { nombre: "DOGV", tipo: "html_directo", url: "https://dogv.gva.es/es/ultimo-diario", ambito: "Comunidad Valenciana" },
  { nombre: "BOA", tipo: "html_directo", url: "https://www.boa.aragon.es/", ambito: "Aragón" },
  { nombre: "BOPA", tipo: "html_directo", url: "https://sede.asturias.es/bopa", ambito: "Asturias" },
  { nombre: "BOIB", tipo: "html_directo", url: "https://intranet.caib.es/eboibfront/es/ultimo-boletin", ambito: "Islas Baleares" },
  { nombre: "BOC", tipo: "html_directo", url: "https://www.gobiernodecanarias.org/boc/ultimo/", ambito: "Canarias" },
  { nombre: "BOC_CANTABRIA", tipo: "html_directo", url: "https://boc.cantabria.es/boces/ultimo-boletin", ambito: "Cantabria" },
  { nombre: "DOCM", tipo: "html_directo", url: "https://docm.castillalamancha.es/portaldocm/verUltimoDiario.do", ambito: "Castilla-La Mancha" },
  { nombre: "BOCYL", tipo: "html_directo", url: "https://bocyl.jcyl.es/ultimoBoletin.do", ambito: "Castilla y León" },
  { nombre: "DOGC", tipo: "html_directo", url: "https://dogc.gencat.cat/es/document-del-dogc/", ambito: "Cataluña" },
  { nombre: "DOE", tipo: "html_directo", url: "https://doe.juntaex.es/ultima-portada/", ambito: "Extremadura" },
  { nombre: "BORM", tipo: "html_directo", url: "https://www.borm.es/#/borm/sumario", ambito: "Región de Murcia" },
  { nombre: "BON", tipo: "html_directo", url: "https://bon.navarra.es/es/boletin-del-dia", ambito: "Navarra" },
  { nombre: "BOPV", tipo: "html_directo", url: "https://www.euskadi.eus/r48-bopv/es/bopv2/datos/Ultimo.shtml", ambito: "País Vasco" },
  { nombre: "BOR", tipo: "html_directo", url: "https://web.larioja.org/bor-ultimo", ambito: "La Rioja" }
];

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function gestionarDepartamento(nombre) {
  if (!nombre) return;
  const slugDep = slugify(nombre, { lower: true, strict: true, remove: /[*+~.()'"!:@]/g });
  const { error } = await supabase
    .from('departments')
    .upsert({ name: nombre, slug: slugDep }, { onConflict: 'slug', ignoreDuplicates: true });
  if (error) console.error(`⚠️ Error departamento ${nombre}:`, error.message);
}

// --- 3. EXTRACCIÓN UNIVERSAL (API CLOUDFLARE) ---
async function obtenerTextoUniversal(url) {
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/browser_rendering/crawl`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url: url, format: "markdown", follow_links: false })
    });

    if (!response.ok) return null;
    const data = await response.json();
    let textoLimpio = data.result?.markdown || "";
    return textoLimpio.substring(0, 15000); // Límite de tokens para Llama-3
  } catch (error) {
    console.error(`⚠️ Error en Cloudflare para ${url}:`, error.message);
    return null; 
  }
}

// --- 4. MOTORES DE IA ---
async function extraerEnlacesSumarioIA(markdownWeb, nombreBoletin) {
  const prompt = `
    Eres un experto en empleo público. Aquí tienes el sumario/portada del boletín ${nombreBoletin} en Markdown.
    Busca TODAS las convocatorias de empleo público (oposiciones, concursos, bolsas de trabajo, estabilización).
    Ignora subvenciones, multas, nombramientos de altos cargos o ceses.
    Devuelve ÚNICAMENTE un objeto JSON con un array llamado "convocatorias".
    Estructura esperada:
    {
      "convocatorias": [
        { "titulo": "Título de la convocatoria", "enlace": "URL completa absoluta extraída del markdown", "departamento": "Organismo que convoca" }
      ]
    }
    Si no hay nada relevante, devuelve { "convocatorias": [] }.
    TEXTO:
    ${markdownWeb}
  `;

  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      temperature: 0.1, 
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: "You output strict JSON." }, { role: "user", content: prompt }]
    });
    return JSON.parse(response.choices[0].message.content).convocatorias || [];
  } catch (error) {
    console.error("⚠️ Error IA extrayendo sumario:", error.message);
    return [];
  }
}

async function analizarConvocatoriaIA(titulo, textoInterior) {
  const prompt = `
  Eres un experto en extraer datos del empleo público. Analiza el texto oficial de esta publicación.
  TÍTULO: ${titulo}
  TEXTO INTERIOR: ${textoInterior}
  
  Devuelve ÚNICAMENTE un objeto JSON válido con esta estructura exacta:
  {
    "tipo": "Uno de estos: 'OPOSICION - Nueva Convocatoria', 'OPOSICION - Convocatoria (Estabilización)', 'OPOSICION - Bolsas de Empleo', 'OPOSICION - Otros Trámites'.",
    "plazas": Número entero (o null),
    "resumen": "Resumen claro de 1-2 frases.",
    "plazo_texto": "Extrae SOLO la duración (ej: '20 días hábiles'). Si no hay, null.",
    "grupo": "El grupo (ej: 'A1', 'C2'). Si no, null.",
    "sistema": "'Oposición', 'Concurso-oposición', 'Concurso', o null.",
    "profesion": "Nombre limpio del puesto (ej: 'Policía Local'). Si no, null.",
    "provincia": "Provincia deducida (ej: 'Madrid'). Si es Ministerio, 'Estatal'.",
    "titulacion": "Titulación mínima exigida. Si no se menciona, null.",
    "enlace_inscripcion": "URL exacta para presentar instancia. Si no, null.",
    "tasa": "Importe de la tasa. Si no, null.",
    "referencia_bases": "Busca si el texto menciona que las bases íntegras están publicadas en otro boletín. Si lo menciona, extrae el nombre del boletín, número y fecha. Si no, devuelve null.",
    "referencia_boe_original": "Si esto es una actualización, busca el código original de la convocatoria a la que hace referencia (ej: BOE-A-YYYY-XXXX o similar). Si no, null."
  }
  `;

  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      temperature: 0.1, 
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: "You output strict JSON." }, { role: "user", content: prompt }]
    });
    return JSON.parse(response.choices[0].message.content);
  } catch (error) {
    console.error("⚠️ Error con IA analizando detalle:", error.message);
    return { tipo: "OPOSICION - Otros Trámites", plazas: null, resumen: titulo };
  }
}

// --- 5. LÓGICA DE BASE DE DATOS (SUPABASE) ---
async function procesarYGuardarConvocatoria(itemData, textoParaIA, fuente, convocatoriasInsertadasHoy) {
  const analisisIA = await analizarConvocatoriaIA(itemData.title, textoParaIA);
  
  let parentSlug = null;
  if (analisisIA.referencia_boe_original) {
    const { data: parentMatch } = await supabase.from('convocatorias').select('slug')
      .like('link_boe', `%${analisisIA.referencia_boe_original}%`).single();
    if (parentMatch) parentSlug = parentMatch.slug;
  }

  let textoParaSlug = analisisIA.profesion ? `oposiciones-${analisisIA.plazas ? analisisIA.plazas + '-plazas-' : ''}${analisisIA.profesion}-${itemData.department || fuente.nombre}` : (analisisIA.resumen || itemData.title);
  let slugBase = slugify(textoParaSlug, { lower: true, strict: true, remove: /[*+~.()'"!:@,]/g });
  if (slugBase.length > 80) slugBase = slugBase.substring(0, 80).replace(/-+$/, '');
  
  // Usamos un sufijo único para evitar colisiones
  const suffix = itemData.guid ? itemData.guid.split('=').pop().replace(/\W/g, '').substring(0,6) : new Date().getTime().toString().slice(-6);
  const slugFinal = `${slugBase}-${suffix}`;

  const convocatoria = {
    slug: slugFinal, 
    title: itemData.title, 
    meta_description: analisisIA.resumen?.substring(0, 150) + "..." || "Ver detalles.",
    section: itemData.section, 
    department: itemData.department, 
    guid: itemData.link, 
    parent_type: "OPOSICION", 
    type: analisisIA.tipo, 
    plazas: analisisIA.plazas, 
    resumen: analisisIA.resumen, 
    plazo_texto: analisisIA.plazo_texto, 
    grupo: analisisIA.grupo, 
    sistema: analisisIA.sistema, 
    profesion: analisisIA.profesion, 
    provincia: analisisIA.provincia || fuente.ambito, 
    titulacion: analisisIA.titulacion, 
    enlace_inscripcion: analisisIA.enlace_inscripcion, 
    tasa: analisisIA.tasa,
    referencia_bases: analisisIA.referencia_bases, 
    parent_slug: parentSlug, 
    publication_date: new Date().toISOString().split('T')[0], 
    link_boe: itemData.link, 
    raw_text: textoParaIA,
  };

  const { data, error } = await supabase.from("convocatorias").upsert(convocatoria, { onConflict: "slug" }).select();
  
  if (error) {
    console.error(`❌ Error BD:`, error.message);
  } else {
    console.log(`✅ Guardado -> ${fuente.nombre} | Tipo: ${analisisIA.tipo} | Plazas: ${analisisIA.plazas}`);
    if (data && data.length > 0) convocatoriasInsertadasHoy.push(data[0]);
  }
}

// --- 6. SISTEMAS DE ALERTAS (ORIGINALES) ---
async function enviarAlertasPorEmail(nuevasConvocatorias) {
  const convocatoriasReales = nuevasConvocatorias.filter(c => 
    c.type === 'OPOSICION - Nueva Convocatoria' || 
    c.type === 'OPOSICION - Convocatoria (Estabilización)' || 
    c.type === 'OPOSICION - Bolsas de Empleo'
  );

  if (convocatoriasReales.length === 0) return;
  if (!process.env.RESEND_API_KEY) return;

  const resend = new Resend(process.env.RESEND_API_KEY);
  const { data: suscriptores, error } = await supabase.from('suscriptores').select('*');

  if (error || !suscriptores || suscriptores.length === 0) return;

  console.log(`📨 Cruzando ${convocatoriasReales.length} plazas nuevas con ${suscriptores.length} suscriptores...`);

  for (const sub of suscriptores) {
    if (!sub.interes) continue;
    const interesStr = sub.interes.toLowerCase().trim();
    const provinciasSub = sub.provincias || []; 

    const coincidencias = convocatoriasReales.filter(conv => {
      const enTitulo = conv.title && conv.title.toLowerCase().includes(interesStr);
      const enProfesion = conv.profesion && conv.profesion.toLowerCase().includes(interesStr);
      const encajaInteres = enTitulo || enProfesion;

      let encajaProvincia = true;
      if (provinciasSub.length > 0) {
        encajaProvincia = provinciasSub.includes(conv.provincia);
      }
      return encajaInteres && encajaProvincia;
    });

    if (coincidencias.length > 0) {
      const htmlLista = coincidencias.map(c => 
        `<li style="margin-bottom: 12px; padding: 10px; background: #f8fafc; border-radius: 8px;">
          <strong style="color: #0f172a; display: block; margin-bottom: 4px;">${c.profesion || c.title}</strong>
          <span style="font-size: 13px; color: #475569; display: block; margin-bottom: 6px;">🏛️ ${c.department || 'Admon.'} ${c.provincia && c.provincia !== 'Estatal' ? `(${c.provincia})` : ''}</span>
          <a href="https://topos.es/convocatorias/${c.slug}" style="display: inline-block; background: #ea580c; color: white; text-decoration: none; padding: 6px 12px; border-radius: 6px; font-size: 13px; font-weight: bold;">Ver plazos y requisitos &rarr;</a>
        </li>`
      ).join('');

      try {
        const enlaceBaja = `https://topos.es/baja?email=${encodeURIComponent(sub.email)}`;
        await resend.emails.send({
          from: 'El Topo de las Opos <alertas@topos.es>', 
          to: sub.email,
          subject: `🚨 Se han publicado plazas de ${sub.interes}`,
          html: `
            <div style="font-family: system-ui, -apple-system, sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
              <h2 style="color: #ea580c; text-align: center; margin-bottom: 20px;">¡Hola! El Topo tiene noticias 🐾</h2>
              <p style="font-size: 16px;">Nuevas publicaciones que coinciden con tu alerta de <strong>"${sub.interes}"</strong>:</p>
              <ul style="list-style: none; padding: 0;">${htmlLista}</ul>
              <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 30px 0 20px 0;" />
              <p style="font-size: 12px; text-align: center;"><a href="${enlaceBaja}" style="color: #94a3b8;">Cancelar suscripción</a></p>
            </div>
          `
        });
        await esperar(1000); 
      } catch (err) {
        console.error(`❌ Error enviando email a ${sub.email}:`, err);
      }
    }
  }
}

async function enviarAlertasFavoritos(nuevasConvocatorias) {
  const actualizaciones = nuevasConvocatorias.filter(c => c.parent_slug);

  if (actualizaciones.length === 0) return;
  if (!process.env.RESEND_API_KEY) return;

  const resend = new Resend(process.env.RESEND_API_KEY);
  console.log(`🔔 Se han detectado ${actualizaciones.length} actualizaciones de trámites. Buscando seguidores...`);

  for (const update of actualizaciones) {
    const { data: seguidores, error } = await supabase
      .from('favoritos')
      .select('user_id')
      .eq('convocatoria_slug', update.parent_slug);
    
    if (error || !seguidores || seguidores.length === 0) continue;

    console.log(`   -> La actualización '${update.title.substring(0, 30)}...' tiene ${seguidores.length} seguidores.`);

    for (const seguidor of seguidores) {
      const { data: userData } = await supabase.auth.admin.getUserById(seguidor.user_id);
      
      if (userData && userData.user && userData.user.email) {
        const email = userData.user.email;
        try {
          await resend.emails.send({
            from: 'Novedades El Topo <alertas@topos.es>', 
            to: email,
            subject: `🔔 Hay novedades en la oposición que sigues`,
            html: `
              <div style="font-family: system-ui, -apple-system, sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
                <div style="text-align: center; margin-bottom: 20px;">
                  <span style="font-size: 40px;">🔔</span>
                  <h2 style="color: #10b981; margin: 10px 0 0 0;">¡Actualización en tu plaza!</h2>
                </div>
                <p style="font-size: 16px;">Acabamos de detectar un nuevo trámite oficial para la plaza que tienes guardada en favoritos.</p>
                <div style="background: #f8fafc; padding: 15px; border-left: 4px solid #10b981; border-radius: 0 8px 8px 0; margin: 20px 0;">
                  <strong style="color: #0f172a; display: block; margin-bottom: 5px;">Nuevo trámite publicado:</strong>
                  <span style="color: #475569; font-size: 14px;">${update.resumen || update.title}</span>
                </div>
                <div style="text-align: center; margin-top: 30px;">
                  <a href="https://topos.es/convocatorias/${update.slug}" style="display: inline-block; background: #10b981; color: white; text-decoration: none; padding: 10px 20px; border-radius: 8px; font-size: 15px; font-weight: bold;">Ver documento oficial</a>
                </div>
              </div>
            `
          });
          console.log(`      ✅ Aviso enviado al usuario: ${email}`);
          await esperar(1000); 
        } catch (err) {
          console.error(`      ❌ Error enviando novedad a ${email}:`, err);
        }
      }
    }
  }
}

async function enviarAlertaTelegram(nuevasConvocatorias) {
  const convocatoriasReales = nuevasConvocatorias.filter(c => 
    c.type === 'OPOSICION - Nueva Convocatoria' || 
    c.type === 'OPOSICION - Convocatoria (Estabilización)' || 
    c.type === 'OPOSICION - Bolsas de Empleo'
  );

  if (convocatoriasReales.length === 0) return;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHANNEL_ID; 

  if (!token || !chatId) return;

  console.log(`📣 Preparando resumen para Telegram...`);
  let texto = `🚨 *¡Nuevas Oposiciones!* 🚨\n\nHoy se han publicado *${convocatoriasReales.length}* nuevas oportunidades:\n\n`;

  const topConv = convocatoriasReales.slice(0, 10);
  topConv.forEach(c => {
    const plazas = c.plazas ? `(*${c.plazas} plazas*) ` : '';
    texto += `💼 *${c.profesion || 'Plaza'}* ${plazas}\n`;
    texto += `🏛️ ${c.department || 'Administración'} ${c.provincia && c.provincia !== 'Estatal' ? `(${c.provincia})` : ''}\n`;
    texto += `👉 [Ver plazos](https://topos.es/convocatorias/${c.slug})\n\n`;
  });

  if (convocatoriasReales.length > 10) texto += `_Y ${convocatoriasReales.length - 10} convocatorias más._\n`;
  texto += `🔍 [Busca la tuya en topos.es](https://topos.es)`;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'Markdown', disable_web_page_preview: true })
    });
  } catch (err) {
    console.error("❌ Error con Telegram:", err);
  }
}

// --- 7. BUCLE PRINCIPAL ---
async function extraerBoletines() {
  try {
    const convocatoriasInsertadasHoy = [];

    for (const fuente of FUENTES_BOLETINES) {
      console.log(`\n==============================================`);
      console.log(`📡 Rastreando ${fuente.nombre} (${fuente.ambito}) - Modo: ${fuente.tipo}`);
      console.log(`==============================================`);
      
      try {
        if (fuente.tipo === "rss") {
          const feed = await parser.parseURL(fuente.url);
          for (const item of feed.items.reverse()) {
            // Filtro rápido para no gastar IA en nombramientos o ceses
            const t = item.title.toLowerCase();
            if (!t.includes('oposición') && !t.includes('concurso') && !t.includes('provisión') && !t.includes('empleo') && !t.includes('plaza') && !t.includes('bolsa')) continue;

            const categoriaSeccion = item.categories?.[0] || `Boletín ${fuente.nombre}`;
            const categoriaOrganismo = item.categories?.[1] || fuente.ambito;
            await gestionarDepartamento(categoriaOrganismo);

            console.log(`\n📄 Extrayendo interior de: ${item.title.substring(0,60)}...`);
            let textoParaIA = await obtenerTextoUniversal(item.link) || item.contentSnippet;
            
            await procesarYGuardarConvocatoria({ 
              title: item.title, link: item.link, section: categoriaSeccion, department: categoriaOrganismo 
            }, textoParaIA, fuente, convocatoriasInsertadasHoy);
            
            await esperar(2000);
          }
        } 
        
        else if (fuente.tipo === "html_directo") {
          const markdownWeb = await obtenerTextoUniversal(fuente.url); 
          if (!markdownWeb) continue;

          console.log(`🤖 Buscando enlaces de empleo en el sumario de ${fuente.nombre}...`);
          const listado = await extraerEnlacesSumarioIA(markdownWeb, fuente.nombre);
          
          if (listado.length > 0) {
              console.log(`✅ Encontradas ${listado.length} posibles convocatorias.`);
          } else {
              console.log(`ℹ️ Hoy no se ha encontrado empleo público en este boletín.`);
          }

          for (const item of listado) {
            await gestionarDepartamento(item.departamento);
            
            console.log(`\n📄 Extrayendo interior de: ${item.titulo.substring(0,60)}...`);
            let textoInterior = await obtenerTextoUniversal(item.enlace);
            if(!textoInterior) continue;

            await procesarYGuardarConvocatoria({ 
              title: item.titulo, link: item.enlace, section: `Boletín ${fuente.nombre}`, department: item.departamento 
            }, textoInterior, fuente, convocatoriasInsertadasHoy);
            
            await esperar(2000);
          }
        }
      } catch (err) {
        console.error(`❌ Error procesando ${fuente.nombre}:`, err.message);
      }
    }

    console.log(`\n🎉 RASTREO COMPLETADO. Total nuevas insertadas: ${convocatoriasInsertadasHoy.length}`);
    
    // --- LLAMADAS A MOTORES DE AVISOS ---
   /*  if (convocatoriasInsertadasHoy.length > 0) {
      await enviarAlertasPorEmail(convocatoriasInsertadasHoy);
      await enviarAlertasFavoritos(convocatoriasInsertadasHoy);
      await enviarAlertaTelegram(convocatoriasInsertadasHoy);
    } */

    if (process.env.VERCEL_WEBHOOK && convocatoriasInsertadasHoy.length > 0) {
      await fetch(process.env.VERCEL_WEBHOOK, { method: 'POST' });
    }

  } catch (error) {
    console.error("🔥 Error crítico general:", error);
    process.exit(1);
  }
}

// ¡Ejecutar!
extraerBoletines();