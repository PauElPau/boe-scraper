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
  Analiza el texto oficial de esta publicación (hemos extraído la introducción del documento real).
  
  TÍTULO: ${titulo}
  TEXTO INTERIOR DEL BOE: ${textoInterior}
  
  Devuelve ÚNICAMENTE un objeto JSON válido con esta estructura exacta, sin texto adicional ni código markdown:
  {
    "tipo": "Uno de estos valores exactos: 'OPOSICION - Nueva Convocatoria', 'OPOSICION - Convocatoria (Estabilización)', 'OPOSICION - Convocatoria (Promoción Interna)', 'OPOSICION - Bolsas de Empleo', 'OPOSICION - Traslados / Libre Designación', 'OPOSICION - Correcciones y Modificaciones', 'OPOSICION - Listas de Admitidos/Excluidos', 'OPOSICION - Exámenes y Calificaciones', 'OPOSICION - Tribunales', 'OPOSICION - Aprobados y Adjudicaciones', 'OPOSICION - Otros Trámites'.",
    "plazas": Número entero de plazas ofertadas (si no se indica un número, devuelve null),
    "resumen": "Resumen claro y directo de 1 o 2 frases para humanos, sin jerga burocrática.",
    "plazo_texto": "Extrae SOLO la duración numérica y el tipo de días, de forma extremadamente concisa (ej: '20 días hábiles', '15 días naturales', '1 mes'). OMITE ABSOLUTAMENTE todo el texto burocrático como 'a contar desde el día siguiente al de la publicación...' o similares. Si no hay plazo, devuelve null.",
    "grupo": "El grupo o subgrupo funcionarial si se menciona (ej: 'A1', 'A2', 'C1', 'C2', 'E', 'Agrupaciones Profesionales'). Si no se menciona, devuelve null.",
    "sistema": "El sistema de selección. Valores permitidos: 'Oposición', 'Concurso-oposición', 'Concurso', o null si no se menciona.",
    "profesion": "El nombre del puesto de trabajo, cuerpo o categoría de forma limpia y directa (ej: 'Auxiliar Administrativo', 'Policía Local', 'Técnico de Gestión'). Si no aplica, devuelve null.",
    "provincia": "A partir del organismo convocante, deduce la provincia española a la que pertenece (ej: si es Ayuntamiento de Valencia, la provincia es 'Valencia'). Si es a nivel estatal (Ministerios) devuelve 'Estatal'. Si no estás seguro, devuelve null.",
    "titulacion": "La titulación académica mínima exigida para presentarse (ej: 'Graduado en ESO', 'Bachiller', 'Grado Universitario'). Si no se menciona explícitamente en el texto, devuelve null.",
    "enlace_inscripcion": "La URL, página web o sede electrónica exacta que se mencione para ver las bases o presentar la instancia (ej: 'www.madrid.es', 'sede.policia.gob.es'). Si no se menciona ninguna web, devuelve null.",
    "tasa": "El importe de la tasa por derechos de examen si aparece detallado (ej: '15,50€'). Si no se menciona, devuelve null."
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
  // Filtramos para enviar correos SOLO de las oposiciones reales, no de correcciones o tribunales
  const convocatoriasReales = nuevasConvocatorias.filter(c => 
    c.type === 'OPOSICION - Nueva Convocatoria' || 
    c.type === 'OPOSICION - Convocatoria (Estabilización)' || 
    c.type === 'OPOSICION - Bolsas de Empleo'
  );

  if (convocatoriasReales.length === 0) {
    console.log("📨 No hay convocatorias de tipo 'Nueva', 'Estabilización' o 'Bolsa' para alertar hoy.");
    return;
  }

  // Comprobamos que exista la clave de Resend en el entorno
  if (!process.env.RESEND_API_KEY) {
    console.error("⚠️ Falta la variable RESEND_API_KEY en el .env o GitHub Secrets");
    return;
  }

  const resend = new Resend(process.env.RESEND_API_KEY);

  const { data: suscriptores, error } = await supabase.from('suscriptores').select('*');

  if (error || !suscriptores || suscriptores.length === 0) {
    console.log("📨 No hay suscriptores en la base de datos o hubo un error al leerlos.");
    return;
  }

  console.log(`📨 Cruzando ${convocatoriasReales.length} plazas nuevas con ${suscriptores.length} suscriptores...`);

  for (const sub of suscriptores) {
    if (!sub.interes) continue;
    const interesStr = sub.interes.toLowerCase().trim();

    const coincidencias = convocatoriasReales.filter(conv => {
      const enTitulo = conv.title && conv.title.toLowerCase().includes(interesStr);
      const enProfesion = conv.profesion && conv.profesion.toLowerCase().includes(interesStr);
      return enTitulo || enProfesion;
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
        await resend.emails.send({
          from: 'El Topo de las Opos <alertas@topos.es>', // <-- CAMBIA ESTO SI VERIFICASTE OTRO DOMINIO EN RESEND
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
              <p style="font-size: 12px; color: #94a3b8; text-align: center;">Estás recibiendo este correo porque activaste una alerta en topos.es</p>
            </div>
          `
        });
        console.log(`✅ Alerta enviada a ${sub.email}`);
        await esperar(1000); // Pequeña pausa para no saturar la API de Resend
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
      const slugBase = slugify(item.title, { lower: true, strict: true, remove: /[*+~.()'"!:@]/g });
      const slugRecortado = slugBase.length > 100 ? slugBase.substring(0, 100) : slugBase;
      const añoActual = new Date().getFullYear();
      const slugFinal = `${slugRecortado}-${añoActual}`;

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