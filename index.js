require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const Parser = require("rss-parser");
const slugify = require("slugify");
const { OpenAI } = require("openai");
const cheerio = require("cheerio"); 
const { Resend } = require('resend'); // Corregido: en Node.js usamos require en lugar de import

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

// --- CEREBRO IA ACTUALIZADO Y SUPERVITAMINADO ---
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
    "referencia_bases": "Busca si el texto menciona que las bases íntegras están publicadas en otro boletín (ej: 'Boletín Oficial de la Provincia de...', 'BOCM', 'DOGC', etc.). Si lo menciona, extrae el nombre del boletín, número y fecha. Ej: 'Boletín Oficial de la Comunidad de Madrid número 53, de 4 de marzo'. Si el propio BOE tiene las bases o no menciona otro boletín, devuelve null."
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
      grupo: null, sistema: null, profesion: null, provincia: null, titulacion: null, enlace_inscripcion: null, tasa: null
    };
  }
}

// --- NUEVA FUNCIÓN: ENVIAR ALERTAS CON RESEND ---
async function enviarAlertasPorEmail(nuevasConvocatorias) {
  const convocatoriasReales = nuevasConvocatorias.filter(c => 
    c.type === 'OPOSICION - Nueva Convocatoria' || 
    c.type === 'OPOSICION - Convocatoria (Estabilización)' || 
    c.type === 'OPOSICION - Bolsas de Empleo'
  );

  if (convocatoriasReales.length === 0) return;

  if (!process.env.RESEND_API_KEY) {
    console.error("⚠️ Falta la variable RESEND_API_KEY en el .env o GitHub Secrets");
    return;
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const { data: suscriptores, error } = await supabase.from('suscriptores').select('*');

  if (error || !suscriptores || suscriptores.length === 0) return;

  console.log(`📨 Cruzando ${convocatoriasReales.length} plazas nuevas con ${suscriptores.length} suscriptores...`);

  for (const sub of suscriptores) {
    if (!sub.interes) continue;
    const interesStr = sub.interes.toLowerCase().trim();
    // Leemos el array de provincias del usuario (si es nulo, lo convertimos a array vacío)
    const provinciasSub = sub.provincias || []; 

    const coincidencias = convocatoriasReales.filter(conv => {
      // 1. ¿Le interesa la profesión?
      const enTitulo = conv.title && conv.title.toLowerCase().includes(interesStr);
      const enProfesion = conv.profesion && conv.profesion.toLowerCase().includes(interesStr);
      const encajaInteres = enTitulo || enProfesion;

      // 2. ¿Encaja en su provincia?
      let encajaProvincia = true;
      // Si el usuario seleccionó al menos una provincia, comprobamos. Si no, encajaProvincia sigue siendo true (Toda España)
      if (provinciasSub.length > 0) {
        // La plaza coincide si su provincia está dentro de lo que marcó el usuario
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
        // Generamos un enlace de baja seguro convirtiendo caracteres extraños (ej: el @)
        const enlaceBaja = `https://topos.es/baja?email=${encodeURIComponent(sub.email)}`;

        await resend.emails.send({
          from: 'El Topo de las Opos <alertas@topos.es>', 
          to: sub.email,
          subject: `🚨 Se han publicado plazas de ${sub.interes}`,
          html: `
            <div style="font-family: system-ui, -apple-system, sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
              <div style="text-align: center; margin-bottom: 20px;">
                <h2 style="color: #ea580c; margin: 0;">¡Hola! El Topo tiene noticias 🐾</h2>
              </div>
              <p style="font-size: 16px;">Acabamos de detectar nuevas publicaciones en el BOE que coinciden con tu alerta de <strong>"${sub.interes}"</strong>:</p>
              <ul style="list-style: none; padding: 0;">
                ${htmlLista}
              </ul>
              <p style="margin-top: 30px; font-size: 15px;">¡Mucha suerte con el estudio!</p>
              
              <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 30px 0 20px 0;" />
              <p style="font-size: 12px; color: #94a3b8; text-align: center; margin-bottom: 5px;">
                Estás recibiendo este correo porque activaste una alerta en topos.es
              </p>
              <p style="font-size: 12px; text-align: center; margin: 0;">
                <a href="${enlaceBaja}" style="color: #94a3b8; text-decoration: underline;">Cancelar suscripción y dejar de recibir alertas</a>
              </p>
            </div>
          `
        });
        console.log(`✅ Alerta enviada a ${sub.email}`);
        await new Promise(resolve => setTimeout(resolve, 1000)); 
      } catch (err) {
        console.error(`❌ Error enviando email a ${sub.email}:`, err);
      }
    }
  }
}

// --- NUEVA FUNCIÓN: ENVIAR RESUMEN A TELEGRAM ---
async function enviarAlertaTelegram(nuevasConvocatorias) {
  // Solo avisamos de las plazas reales
  const convocatoriasReales = nuevasConvocatorias.filter(c => 
    c.type === 'OPOSICION - Nueva Convocatoria' || 
    c.type === 'OPOSICION - Convocatoria (Estabilización)' || 
    c.type === 'OPOSICION - Bolsas de Empleo'
  );

  if (convocatoriasReales.length === 0) return;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHANNEL_ID; 

  if (!token || !chatId) {
    console.error("⚠️ Faltan las variables de Telegram en .env o GitHub Secrets");
    return;
  }

  console.log(`📣 Preparando resumen para Telegram con ${convocatoriasReales.length} plazas...`);

  // Construimos el mensaje con formato Markdown de Telegram
  let texto = `🚨 *¡Nuevas Oposiciones en el BOE!* 🚨\n\n`;
  texto += `Hoy se han publicado *${convocatoriasReales.length}* nuevas oportunidades:\n\n`;

  // Cogemos las 10 primeras para no hacer un mensaje kilométrico
  const topConv = convocatoriasReales.slice(0, 10);
  topConv.forEach(c => {
    const plazas = c.plazas ? `(*${c.plazas} plazas*) ` : '';
    const org = c.department || 'Administración';
    texto += `💼 *${c.profesion || 'Plaza'}* ${plazas}\n`;
    texto += `🏛️ ${org} ${c.provincia && c.provincia !== 'Estatal' ? `(${c.provincia})` : ''}\n`;
    texto += `👉 [Ver detalles y plazos](https://topos.es/convocatorias/${c.slug})\n\n`;
  });

  if (convocatoriasReales.length > 10) {
    texto += `_Y ${convocatoriasReales.length - 10} convocatorias más._\n`;
  }
  
  texto += `🔍 [Busca la tuya en topos.es](https://topos.es)`;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: texto,
        parse_mode: 'Markdown',
        disable_web_page_preview: true // Evita que salga una imagen gigante de previsualización
      })
    });
    
    const result = await response.json();
    if (!result.ok) {
       console.error("❌ Error enviando a Telegram:", result.description);
    } else {
       console.log("✅ Resumen enviado a Telegram correctamente.");
    }
  } catch (err) {
    console.error("❌ Error de red con Telegram:", err);
  }
}

// --- BUCLE PRINCIPAL ---
async function extraerBOE() {
  try {
    console.log(`📡 Conectando con el BOE...`);
    const feed = await parser.parseURL(BOE_RSS_URL);
    let nuevasInsertadas = 0;
    const items = feed.items.reverse();
    
    // Array para guardar en memoria lo que metemos hoy y luego pasárselo a Resend
    const convocatoriasInsertadasHoy = [];

    for (const item of items) {
      /*const slugBase = slugify(item.title, { lower: true, strict: true, remove: /[*+~.()'"!:@]/g });
      const slugRecortado = slugBase.length > 100 ? slugBase.substring(0, 100) : slugBase;
      const añoActual = new Date().getFullYear();
      const slugFinal = `${slugRecortado}-${añoActual}`;*/

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

      console.log(`🤖 Analizando con IA (Groq)...`);
      const analisisIA = await analizarConvocatoriaIA(item.title, textoParaIA);

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

      // Limpiamos el texto, le quitamos acentos y caracteres raros
      let slugBase = slugify(textoParaSlug, { lower: true, strict: true, remove: /[*+~.()'"!:@,]/g });
      
      // Recortamos a 80 caracteres (ideal para Google) y evitamos que termine en guion
      if (slugBase.length > 80) slugBase = slugBase.substring(0, 80).replace(/-+$/, '');
      
      // Extraemos el ID único del BOE (ej. BOE-A-2026-1234 -> 2026-1234) para evitar slugs duplicados
      const matchBOE = item.link.match(/id=BOE-[A-Z]-(\d{4}-\d+)/);
      const boeSuffix = matchBOE ? matchBOE[1] : new Date().getTime().toString().slice(-6);
      
      const slugFinal = `${slugBase}-${boeSuffix}`;

      const convocatoria = {
        slug: slugFinal, title: item.title, meta_description: item.contentSnippet?.substring(0, 150) + "..." || "Ver detalles.",
        section: categoriaSeccion, department: categoriaOrganismo, guid: item.guid, parent_type: "OPOSICION", 
        type: analisisIA.tipo, plazas: analisisIA.plazas, resumen: analisisIA.resumen, plazo_texto: analisisIA.plazo_texto,
        grupo: analisisIA.grupo, sistema: analisisIA.sistema, profesion: analisisIA.profesion, provincia: analisisIA.provincia,
        titulacion: analisisIA.titulacion, enlace_inscripcion: analisisIA.enlace_inscripcion, tasa: analisisIA.tasa,
        publication_date: fechaCorrecta, link_boe: item.link, raw_text: textoParaIA,
      };

      const { data, error } = await supabase
        .from("convocatorias")
        .upsert(convocatoria, { onConflict: "slug" })
        .select();

      if (error) {
        console.error(`❌ Error BD:`, error.message);
      } else {
        console.log(`✅ Guardado -> Tipo: ${analisisIA.tipo} | Plazas: ${analisisIA.plazas}`);
        nuevasInsertadas++;
        // Guardamos la convocatoria procesada en el array para luego enviarla por email
        if (data && data.length > 0) {
          convocatoriasInsertadasHoy.push(data[0]);
        }
      }
      
      await esperar(3000); 
    }

    console.log(`🎉 Proceso de lectura completado. Insertadas: ${nuevasInsertadas}`);
    
    // --- LLAMADA A RESEND ---
    if (convocatoriasInsertadasHoy.length > 0) {
      console.log('🚀 Iniciando envío de alertas por correo electrónico...');
      await enviarAlertasPorEmail(convocatoriasInsertadasHoy);

      console.log('🚀 Iniciando envío al canal de Telegram...');
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