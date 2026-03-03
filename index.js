require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const Parser = require("rss-parser");
const slugify = require("slugify");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

// MEJORA: Añadimos un User-Agent falso para que el BOE no nos bloquee por ser un bot
const parser = new Parser({
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  },
});

// NUEVA URL OFICIAL: Sección II.B (Oposiciones y concursos)
const BOE_RSS_URL = "https://www.boe.es/rss/boe.php?s=2B";

async function extraerBOE() {
  try {
    console.log(`📡 Conectando con el BOE en: ${BOE_RSS_URL}...`);
    const feed = await parser.parseURL(BOE_RSS_URL);

    let nuevasInsertadas = 0;

    for (const item of feed.items) {
      const slugBase = slugify(item.title, { lower: true, strict: true, remove: /[*+~.()'"!:@]/g });
      
      // --- CORRECCIÓN ---
      // Cortamos el slug a máximo 100 caracteres para evitar el error ENAMETOOLONG
      // Si es muy largo, lo cortamos sin miramientos.
      const slugRecortado = slugBase.length > 100 ? slugBase.substring(0, 100) : slugBase;
      
      const añoActual = new Date().getFullYear();
      // Generamos un slug limpio y corto
      const slugFinal = `${slugRecortado}-${añoActual}`;

      // Extraemos el texto de forma más segura (el BOE a veces usa contentSnippet o content)
      const textoRaw =
        item.contentSnippet ||
        item.content ||
        item.description ||
        "Ver detalles en el enlace oficial.";

      const convocatoria = {
        slug: slugFinal,
        title: item.title,
        meta_description: textoRaw.substring(0, 150) + "...",
        department: "Administración Pública",
        type: "Oposición",
        publication_date: new Date(item.pubDate),
        link_boe: item.link,
        raw_text: textoRaw,
      };

      const { data, error } = await supabase
        .from("convocatorias")
        .upsert(convocatoria, { onConflict: "slug" })
        .select();

      if (error) {
        console.error(`❌ Error al insertar ${slugFinal}:`, error.message);
      } else {
        console.log(`✅ Procesado: ${item.title.substring(0, 50)}...`);
        nuevasInsertadas++;
      }
    }

    console.log(
      `🎉 Proceso completado. ${nuevasInsertadas} convocatorias revisadas/insertadas.`,
    );

    // Avisamos a Vercel para que regenere la web estática de Astro
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
