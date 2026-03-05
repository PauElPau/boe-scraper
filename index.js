require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const Parser = require("rss-parser");
const slugify = require("slugify");
// Usamos la librería de OpenAI, pero conectada a Groq
const { OpenAI } = require("openai");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

// Configuración de la IA apuntando a Groq (¡Gratis!)
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

// Pausa para ser educados con la API gratuita (3 segundos)
const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function gestionarDepartamento(nombre) {
  if (!nombre) return;
  const slugDep = slugify(nombre, { lower: true, strict: true, remove: /[*+~.()'"!:@]/g });
  const { error } = await supabase
    .from('departments')
    .upsert({ name: nombre, slug: slugDep }, { onConflict: 'slug', ignoreDuplicates: true });

  if (error) {
    console.error(`⚠️ Error gestionando departamento ${nombre}:`, error.message);
  }
}

// --- CEREBRO IA (LLAMA 3 en GROQ) ---
async function analizarConvocatoriaIA(titulo, descripcion) {
  const prompt = `
  Eres un experto en extraer datos del Boletín Oficial del Estado (BOE).
  Analiza la siguiente publicación.
  
  TÍTULO: ${titulo}
  TEXTO: ${descripcion}
  
  Devuelve ÚNICAMENTE un objeto JSON válido con esta estructura exacta, sin texto adicional ni código markdown:
  {
    "tipo": "Uno de estos valores exactos: 'OPOSICION - Nueva Convocatoria', 'OPOSICION - Convocatoria (Estabilización)', 'OPOSICION - Convocatoria (Promoción Interna)', 'OPOSICION - Bolsas de Empleo', 'OPOSICION - Traslados / Libre Designación', 'OPOSICION - Correcciones y Modificaciones', 'OPOSICION - Listas de Admitidos/Excluidos', 'OPOSICION - Exámenes y Calificaciones', 'OPOSICION - Tribunales', 'OPOSICION - Aprobados y Adjudicaciones', 'OPOSICION - Otros Trámites'.",
    "plazas": Número entero de plazas ofertadas (si no hay, devuelve null),
    "resumen": "Resumen claro y directo de 1 o 2 frases para humanos, sin jerga burocrática.",
    "plazo_texto": "El plazo exacto de presentación de instancias que diga el texto (ej: '20 días hábiles'). Si no hay plazo, devuelve null."
  }
  `;

  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile", // Modelo gratuito super potente
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { 
          role: "system", 
          content: "You are a helpful assistant designed to output strict JSON." 
        },
        { role: "user", content: prompt }
      ]
    });

    const resultado = JSON.parse(response.choices[0].message.content);
    return resultado;

  } catch (error) {
    console.error("⚠️ Error con la IA en este item:", error.message);
    return { 
      tipo: "OPOSICION - Otros Trámites", 
      plazas: null, 
      resumen: titulo, 
      plazo_texto: null 
    };
  }
}

async function extraerBOE() {
  try {
    console.log(`📡 Conectando con el BOE en: ${BOE_RSS_URL}...`);
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

      const textoRaw = item.contentSnippet || item.content || item.description || "Ver detalles.";

      console.log(`🤖 Analizando con IA (Groq): ${item.title.substring(0, 50)}...`);
      const analisisIA = await analizarConvocatoriaIA(item.title, textoRaw);

      const convocatoria = {
        slug: slugFinal,
        title: item.title,
        meta_description: textoRaw.substring(0, 150) + "...",
        section: categoriaSeccion,     
        department: categoriaOrganismo, 
        guid: item.guid,       
        parent_type: "OPOSICION",    
        
        // DATOS ESTRUCTURADOS POR LA IA
        type: analisisIA.tipo,
        plazas: analisisIA.plazas,
        resumen: analisisIA.resumen,
        plazo_texto: analisisIA.plazo_texto,
        
        publication_date: fechaCorrecta,
        link_boe: item.link,
        raw_text: textoRaw,
      };

      const { error } = await supabase
        .from("convocatorias")
        .upsert(convocatoria, { onConflict: "slug" })
        .select();

      if (error) {
        console.error(`❌ Error al insertar ${slugFinal}:`, error.message);
      } else {
        console.log(`   ✅ Guardado -> Tipo: ${analisisIA.tipo} | Plazas: ${analisisIA.plazas}`);
        nuevasInsertadas++;
      }
      
      // Esperamos 3 segundos para no saturar la API gratuita
      await esperar(3000);
    }

    console.log(`🎉 Proceso completado. ${nuevasInsertadas} convocatorias procesadas.`);

    if (nuevasInsertadas > 0 && process.env.VERCEL_WEBHOOK) {
      console.log('🚀 Avisando a Vercel para reconstruir la web...');
      await fetch(process.env.VERCEL_WEBHOOK, { method: 'POST' });
      console.log('✅ Aviso enviado.');
    }
  } catch (error) {
    console.error("🔥 Error crítico en el scraper:", error);
    process.exit(1);
  }
}

extraerBOE();