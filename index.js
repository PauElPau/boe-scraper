require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const Parser = require("rss-parser");
const slugify = require("slugify");
// IMPORTAMOS GEMINI
const { GoogleGenerativeAI, SchemaType } = require("@google/generative-ai");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

// Configuración Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const parser = new Parser({
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  },
});

const BOE_RSS_URL = "https://www.boe.es/rss/boe.php?s=2B";

// Función para no superar el límite gratuito de Gemini (15 req/min)
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

// --- CEREBRO GEMINI: SALIDA ESTRUCTURADA ---
async function analizarConvocatoriaGemini(titulo, descripcion) {
  const schema = {
    type: SchemaType.OBJECT,
    properties: {
      tipo: {
        type: SchemaType.STRING,
        description: "Debe ser EXACTAMENTE uno de estos valores: 'OPOSICION - Nueva Convocatoria', 'OPOSICION - Convocatoria (Estabilización)', 'OPOSICION - Convocatoria (Promoción Interna)', 'OPOSICION - Bolsas de Empleo', 'OPOSICION - Traslados / Libre Designación', 'OPOSICION - Correcciones y Modificaciones', 'OPOSICION - Listas de Admitidos/Excluidos', 'OPOSICION - Exámenes y Calificaciones', 'OPOSICION - Tribunales', 'OPOSICION - Aprobados y Adjudicaciones', 'OPOSICION - Otros Trámites'."
      },
      plazas: {
        type: SchemaType.INTEGER,
        description: "Número total de plazas ofertadas numérico. Si no hay plazas numéricas claras, o es una bolsa, o trámite intermedio, devuelve null.",
        nullable: true
      },
      resumen: {
        type: SchemaType.STRING,
        description: "Un resumen claro y directo de 1 frase para humanos. Elimina toda la jerga burocrática del BOE (no uses 'Resolución por la que se...'). Ve al grano: 'Se convocan X plazas de Auxiliar para el Ayuntamiento de Y' o 'Se publica la lista de admitidos para las plazas de...'."
      },
      plazo_texto: {
        type: SchemaType.STRING,
        description: "Extrae el plazo de presentación de instancias exacto (ej: '20 días hábiles', '15 días naturales'). Si es un trámite sin plazo de inscripción, devuelve null.",
        nullable: true
      }
    },
    required: ["tipo", "resumen"]
  };

  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash-latest",
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: schema,
      temperature: 0.2, 
    },
  });

  const prompt = `
  Analiza esta publicación del BOE.
  Extrae la categoría, las plazas, el plazo de inscripción (si lo hay) y redacta un resumen sin jerga.
  
  TÍTULO: ${titulo}
  TEXTO: ${descripcion}
  `;

  try {
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    return JSON.parse(responseText);
  } catch (error) {
    console.error("⚠️ Error con Gemini en este item:", error.message);
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
    
    // Invertimos para guardar primero las más antiguas y mantener el orden cronológico
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

      const textoRaw =
        item.contentSnippet ||
        item.content ||
        item.description ||
        "Ver detalles en el enlace oficial.";

      console.log(`🤖 Analizando con IA: ${item.title.substring(0, 50)}...`);
      const analisisIA = await analizarConvocatoriaGemini(item.title, textoRaw);

      const convocatoria = {
        slug: slugFinal,
        title: item.title,
        meta_description: textoRaw.substring(0, 150) + "...",
        section: categoriaSeccion,     
        department: categoriaOrganismo, 
        guid: item.guid,       
        parent_type: "OPOSICION",    
        
        // --- DATOS MÁGICOS DE LA IA ---
        type: analisisIA.tipo,
        plazas: analisisIA.plazas,
        resumen: analisisIA.resumen,
        plazo_texto: analisisIA.plazo_texto,
        // ------------------------------
        
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
        console.log(`✅ Procesado: ${analisisIA.resumen.substring(0, 50)}...`);
        nuevasInsertadas++;
      }
      
      // Respetamos límite gratuito de Gemini (aprox 4.5s)
      await esperar(4500);
    }

    console.log(`🎉 Proceso completado. ${nuevasInsertadas} convocatorias insertadas/actualizadas.`);

    if (nuevasInsertadas > 0 && process.env.VERCEL_WEBHOOK) {
      console.log('🚀 Avisando a Vercel para reconstruir la web...');
      await fetch(process.env.VERCEL_WEBHOOK, { method: 'POST' });
      console.log('✅ Aviso enviado con éxito.');
    }
  } catch (error) {
    console.error("🔥 Error crítico en el scraper:", error);
    process.exit(1);
  }
}

extraerBOE();