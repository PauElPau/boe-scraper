require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const Parser = require("rss-parser");
const slugify = require("slugify");
const { OpenAI } = require("openai");
const cheerio = require("cheerio"); 
const { Resend } = require('resend'); 

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
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  },
});

const BOE_RSS_URL = "https://www.boe.es/rss/boe.php?s=2B";

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function gestionarDepartamento(nombre) {
  if (!nombre) return;
  const slugDep = slugify(nombre, { lower: true, strict: true, remove: /[*+~.()'"!:@]/g });
  const { error } = await supabase
    .from('departments')
    .upsert({ name: nombre, slug: slugDep }, { onConflict: 'slug', ignoreDuplicates: true });
  if (error) console.error(`⚠️ Error departamento ${nombre}:`, error.message);
}

// --- LEER EL INTERIOR DEL BOE ---
async function obtenerTextoBOE(url) {
  try {
    const respuesta = await fetch(url);
    const html = await respuesta.text();
    const $ = cheerio.load(html);
    let textoLimpio = $('#textoxslt').text();
    textoLimpio = textoLimpio.replace(/\s+/g, ' ').trim();
    return textoLimpio.substring(0, 5000);
  } catch (error) {
    console.error(`⚠️ No se pudo leer el interior de ${url}`);
    return null; 
  }
}

// --- CEREBRO IA ACTUALIZADO ---
async function analizarConvocatoriaIA(titulo, textoInterior) {
  const prompt = `
  Eres un experto en extraer datos del Boletín Oficial del Estado (BOE).
  Analiza el texto oficial de esta publicación.
  
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
    "referencia_bases": "Busca si el texto menciona que las bases íntegras están publicadas en otro boletín (ej: 'Boletín Oficial de la Provincia de...'). Si lo menciona, extrae el nombre del boletín, número y fecha. Si no, devuelve null.",
    "referencia_boe_original": "Si esto es una actualización (listas de admitidos, fechas de examen, tribunal), busca el código BOE original de la convocatoria a la que hace referencia (formato 'BOE-A-YYYY-XXXX'). Si no es una actualización o no aparece el código exacto, devuelve null."
  }
  `;

  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      temperature: 0.1, 
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a helpful assistant designed to output strict JSON." },
        { role: "user", content: prompt }
      ]
    });

    return JSON.parse(response.choices[0].message.content);
  } catch (error) {
    console.error("⚠️ Error con la IA:", error.message);
    return { 
      tipo: "OPOSICION - Otros Trámites", plazas: null, resumen: titulo, plazo_texto: null,
      grupo: null, sistema: null, profesion: null, provincia: null, titulacion: null, enlace_inscripcion: null, tasa: null,
      referencia_bases: null, referencia_boe_original: null
    };
  }
}

// --- FUNCIÓN ORIGINAL: ALERTAS GENÉRICAS ---
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
              <p style="font-size: 16px;">Nuevas publicaciones en el BOE que coinciden con tu alerta de <strong>"${sub.interes}"</strong>:</p>
              <ul style="list-style: none; padding: 0;">${htmlLista}</ul>
              <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 30px 0 20px 0;" />
              <p style="font-size: 12px; text-align: center;"><a href="${enlaceBaja}" style="color: #94a3b8;">Cancelar suscripción</a></p>
            </div>
          `
        });
        await new Promise(resolve => setTimeout(resolve, 1000)); 
      } catch (err) {
        console.error(`❌ Error enviando email a ${sub.email}:`, err);
      }
    }
  }
}

// --- NUEVA FUNCIÓN: ALERTAS A FAVORITOS (USUARIOS REGISTRADOS) ---
async function enviarAlertasFavoritos(nuevasConvocatorias) {
  // Filtramos solo las que son actualizaciones y tienen un "padre" asociado
  const actualizaciones = nuevasConvocatorias.filter(c => c.parent_slug);

  if (actualizaciones.length === 0) return;
  if (!process.env.RESEND_API_KEY) return;

  const resend = new Resend(process.env.RESEND_API_KEY);
  console.log(`🔔 Se han detectado ${actualizaciones.length} actualizaciones de trámites. Buscando seguidores...`);

  for (const update of actualizaciones) {
    // Buscamos quién sigue a la plaza original (el padre)
    const { data: seguidores, error } = await supabase
      .from('favoritos')
      .select('user_id')
      .eq('convocatoria_slug', update.parent_slug);
    
    if (error || !seguidores || seguidores.length === 0) continue;

    console.log(`   -> La actualización '${update.title.substring(0, 30)}...' tiene ${seguidores.length} seguidores.`);

    for (const seguidor of seguidores) {
      // Usamos el Service Key para extraer el email del sistema de autenticación de Supabase
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
                <p style="font-size: 16px;">Acabamos de detectar un nuevo trámite oficial en el BOE para la plaza que tienes guardada en favoritos.</p>
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
          await new Promise(resolve => setTimeout(resolve, 1000)); 
        } catch (err) {
          console.error(`      ❌ Error enviando novedad a ${email}:`, err);
        }
      }
    }
  }
}

// --- TELEGRAM ---
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
  let texto = `🚨 *¡Nuevas Oposiciones en el BOE!* 🚨\n\nHoy se han publicado *${convocatoriasReales.length}* nuevas oportunidades:\n\n`;

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

// --- BUCLE PRINCIPAL ---
async function extraerBOE() {
  try {
    console.log(`📡 Conectando con el BOE...`);
    const feed = await parser.parseURL(BOE_RSS_URL);
    let nuevasInsertadas = 0;
    const items = feed.items.reverse();
    const convocatoriasInsertadasHoy = [];

    for (const item of items) {
      // --- FILTRO: Omitir el Sumario del día ---
      if (item.title === "Sumario") {
        console.log("⏩ Saltando item: Sumario del día.");
        continue;
      }
      const fechaRaw = new Date(item.pubDate);
      fechaRaw.setHours(fechaRaw.getHours() + 14);
      const fechaCorrecta = fechaRaw.toISOString().split('T')[0];

      const categoriaSeccion = item.categories && item.categories[0] ? item.categories[0] : "Otros";
      const categoriaOrganismo = item.categories && item.categories[1] ? item.categories[1] : "Administración Pública";

      await gestionarDepartamento(categoriaOrganismo);

      console.log(`\n📄 Leyendo interior de: ${item.link}`);
      let textoParaIA = await obtenerTextoBOE(item.link);
      if (!textoParaIA || textoParaIA.length < 50) {
        textoParaIA = item.contentSnippet || item.content || item.description;
      }

      console.log(`🤖 Analizando con IA...`);
      const analisisIA = await analizarConvocatoriaIA(item.title, textoParaIA);

      // LÓGICA DE PADRE E HIJO (Enlazar trámites)
      let parentSlug = null;
      if (analisisIA.referencia_boe_original) {
        console.log(`   🔗 Se ha detectado referencia original: ${analisisIA.referencia_boe_original}. Buscando padre...`);
        // Buscamos en nuestra tabla si tenemos alguna convocatoria que contenga ese ID del BOE en su enlace
        const { data: parentMatch } = await supabase
          .from('convocatorias')
          .select('slug')
          .like('link_boe', `%${analisisIA.referencia_boe_original}%`)
          .single();
          
        if (parentMatch) {
          parentSlug = parentMatch.slug;
          console.log(`   🎯 ¡Padre encontrado! Enlazado a: ${parentSlug}`);
        } else {
          console.log(`   ⚠️ El padre no está en nuestra base de datos (es muy antiguo).`);
        }
      }

      let textoParaSlug = "";
      if (analisisIA.profesion) {
        const plazasStr = analisisIA.plazas ? `${analisisIA.plazas}-plazas-` : '';
        const depStr = categoriaOrganismo ? categoriaOrganismo.replace('Ayuntamiento de', '').replace('Ministerio de', '').trim() : '';
        textoParaSlug = `oposiciones-${plazasStr}${analisisIA.profesion}-${depStr}`;
      } else if (analisisIA.resumen) {
        textoParaSlug = analisisIA.resumen;
      } else {
        textoParaSlug = item.title;
      }

      let slugBase = slugify(textoParaSlug, { lower: true, strict: true, remove: /[*+~.()'"!:@,]/g });
      if (slugBase.length > 80) slugBase = slugBase.substring(0, 80).replace(/-+$/, '');
      
      const matchBOE = item.link.match(/id=BOE-[A-Z]-(\d{4}-\d+)/);
      const boeSuffix = matchBOE ? matchBOE[1] : new Date().getTime().toString().slice(-6);
      const slugFinal = `${slugBase}-${boeSuffix}`;

      const convocatoria = {
        slug: slugFinal, title: item.title, meta_description: item.contentSnippet?.substring(0, 150) + "..." || "Ver detalles.",
        section: categoriaSeccion, department: categoriaOrganismo, guid: item.guid, parent_type: "OPOSICION", 
        type: analisisIA.tipo, plazas: analisisIA.plazas, resumen: analisisIA.resumen, plazo_texto: analisisIA.plazo_texto,
        grupo: analisisIA.grupo, sistema: analisisIA.sistema, profesion: analisisIA.profesion, provincia: analisisIA.provincia,
        titulacion: analisisIA.titulacion, enlace_inscripcion: analisisIA.enlace_inscripcion, tasa: analisisIA.tasa,
        referencia_bases: analisisIA.referencia_bases, parent_slug: parentSlug, // <- Aquí guardamos el enlace
        publication_date: fechaCorrecta, link_boe: item.link, raw_text: textoParaIA,
      };

      const { data, error } = await supabase.from("convocatorias").upsert(convocatoria, { onConflict: "slug" }).select();

      if (error) {
        console.error(`❌ Error BD:`, error.message);
      } else {
        console.log(`✅ Guardado -> Tipo: ${analisisIA.tipo} | Plazas: ${analisisIA.plazas}`);
        nuevasInsertadas++;
        if (data && data.length > 0) convocatoriasInsertadasHoy.push(data[0]);
      }
      
      await esperar(3000); 
    }

    console.log(`🎉 Proceso completado. Insertadas: ${nuevasInsertadas}`);
    
    // --- LLAMADAS A LOS MOTORES DE AVISO ---
    if (convocatoriasInsertadasHoy.length > 0) {
      console.log('🚀 Iniciando alertas generales de Boletín...');
      await enviarAlertasPorEmail(convocatoriasInsertadasHoy);
      
      console.log('🚀 Iniciando alertas de Novedades a Favoritos...');
      await enviarAlertasFavoritos(convocatoriasInsertadasHoy);

      console.log('🚀 Iniciando envío a Telegram...');
      await enviarAlertaTelegram(convocatoriasInsertadasHoy);
    }

    if (nuevasInsertadas > 0 && process.env.VERCEL_WEBHOOK) {
      await fetch(process.env.VERCEL_WEBHOOK, { method: 'POST' });
    }
  } catch (error) {
    console.error("🔥 Error crítico:", error);
    process.exit(1);
  }
}

extraerBOE();