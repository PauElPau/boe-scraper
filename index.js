require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const Parser = require("rss-parser");
const slugify = require("slugify");
const { OpenAI } = require("openai");
const cheerio = require("cheerio"); // <--- NUEVA LIBRERÍA

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

// --- NUEVA FUNCIÓN: LEER EL INTERIOR DEL BOE ---
async function obtenerTextoBOE(url) {
  try {
    // 1. Descargamos el código fuente de la página del BOE
    const respuesta = await fetch(url);
    const html = await respuesta.text();
    
    // 2. Usamos Cheerio para leerlo como si fuera jQuery
    const $ = cheerio.load(html);
    
    // El texto oficial del BOE siempre está dentro de un div con id "textoxslt"
    let textoLimpio = $('#textoxslt').text();
    
    // Limpiamos saltos de línea y espacios extra
    textoLimpio = textoLimpio.replace(/\s+/g, ' ').trim();
    
    // 3. RECORTAMOS: Nos quedamos solo con los primeros 1800 caracteres (~400 palabras)
    // Esto es vital para no agotar los tokens gratuitos de Groq y darle solo el resumen inicial.
    return textoLimpio.substring(0, 1800);
  } catch (error) {
    console.error(`⚠️ No se pudo leer el interior de ${url}`);
    return null; // Si falla, devolveremos null
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
    "plazo_texto": "El plazo exacto de presentación de instancias que diga el texto (ej: '20 días hábiles'). Si es un trámite sin plazo, devuelve null.",
    "grupo": "El grupo o subgrupo funcionarial si se menciona (ej: 'A1', 'A2', 'C1', 'C2', 'E', 'Agrupaciones Profesionales'). Si no se menciona, devuelve null.",
    "sistema": "El sistema de selección. Valores permitidos: 'Oposición', 'Concurso-oposición', 'Concurso', o null si no se menciona.",
    "profesion": "El nombre del puesto de trabajo, cuerpo o categoría de forma limpia y directa (ej: 'Auxiliar Administrativo', 'Policía Local', 'Técnico de Gestión'). Si no aplica, devuelve null.",
    "provincia": "A partir del organismo convocante, deduce la provincia española a la que pertenece (ej: si es Ayuntamiento de Valencia, la provincia es 'Valencia'). Si es a nivel estatal (Ministerios) devuelve 'Estatal'. Si no estás seguro, devuelve null."
  }
  `;

  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      temperature: 0.1, // Mantenemos 0.1 para que sea estricto con los formatos
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
      tipo: "OPOSICION - Otros Trámites", 
      plazas: null, 
      resumen: titulo, 
      plazo_texto: null,
      grupo: null,
      sistema: null,
      profesion: null,
      provincia: null
    };
  }
}

async function extraerBOE() {
  try {
    console.log(`📡 Conectando con el BOE...`);
    const feed = await parser.parseURL(BOE_RSS_URL);
    let nuevasInsertadas = 0;
    const items = feed.items.reverse();

    for (const item of items) {
      const slugBase = slugify(item.title, { lower: true, strict: true, remove: /[*+~.()'"!:@]/g });
      const slugRecortado = slugBase.length > 100 ? slugBase.substring(0, 100) : slugBase;
      const añoActual = new Date().getFullYear();
      const slugFinal = `${slugRecortado}-${añoActual}`;

      const fechaRaw = new Date(item.pubDate);
      fechaRaw.setHours(fechaRaw.getHours() + 12);
      const fechaCorrecta = fechaRaw.toISOString().split('T')[0];

      const categoriaSeccion = item.categories && item.categories[0] ? item.categories[0] : "Otros";
      const categoriaOrganismo = item.categories && item.categories[1] ? item.categories[1] : "Administración Pública";

      await gestionarDepartamento(categoriaOrganismo);

      // --- AQUÍ OCURRE LA MAGIA ---
      console.log(`\n📄 Leyendo interior de: ${item.link}`);
      let textoParaIA = await obtenerTextoBOE(item.link);
      
      // Si por algún motivo falla la lectura web, usamos la descripción corta del RSS como plan B
      if (!textoParaIA || textoParaIA.length < 50) {
        textoParaIA = item.contentSnippet || item.content || item.description;
      }

      console.log(`🤖 Analizando con IA (Groq)...`);
      const analisisIA = await analizarConvocatoriaIA(item.title, textoParaIA);

      const convocatoria = {
        slug: slugFinal,
        title: item.title,
        meta_description: item.contentSnippet?.substring(0, 150) + "..." || "Ver detalles.",
        section: categoriaSeccion,     
        department: categoriaOrganismo, 
        guid: item.guid,       
        parent_type: "OPOSICION",    
        
        type: analisisIA.tipo,
        plazas: analisisIA.plazas,
        resumen: analisisIA.resumen,
        plazo_texto: analisisIA.plazo_texto,

        grupo: analisisIA.grupo,
        sistema: analisisIA.sistema,
        profesion: analisisIA.profesion,
        provincia: analisisIA.provincia,
        
        publication_date: fechaCorrecta,
        link_boe: item.link,
        raw_text: textoParaIA, // Opcional: guardamos el texto recortado en BD
      };

      const { error } = await supabase
        .from("convocatorias")
        .upsert(convocatoria, { onConflict: "slug" })
        .select();

      if (error) {
        console.error(`❌ Error BD:`, error.message);
      } else {
        console.log(`✅ Guardado -> Tipo: ${analisisIA.tipo} | Plazas: ${analisisIA.plazas}`);
        nuevasInsertadas++;
      }
      
      await esperar(3000); // 3 segundos de pausa
    }

    console.log(`🎉 Proceso completado.`);
    if (nuevasInsertadas > 0 && process.env.VERCEL_WEBHOOK) {
      await fetch(process.env.VERCEL_WEBHOOK, { method: 'POST' });
    }
  } catch (error) {
    console.error("🔥 Error crítico:", error);
    process.exit(1);
  }
}

extraerBOE();