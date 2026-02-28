require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const Parser = require("rss-parser");
const slugify = require("slugify");

// 1. Conexión a Supabase (usamos las variables de entorno)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

const parser = new Parser();

// URL oficial del RSS del BOE (Empleo público / Oposiciones)
const BOE_RSS_URL = "https://www.boe.es/rss/canal.php?c=oposiciones";

async function extraerBOE() {
  try {
    console.log("📡 Conectando con el BOE...");
    const feed = await parser.parseURL(BOE_RSS_URL);

    let nuevasInsertadas = 0;

    // 2. Recorremos cada publicación del día
    for (const item of feed.items) {
      // 3. Magia pSEO: Generamos un slug perfecto para Google
      // Limpiamos palabras raras y lo hacemos minúsculas
      const slugBase = slugify(item.title, {
        lower: true,
        strict: true,
        remove: /[*+~.()'"!:@]/g,
      });
      // Añadimos el año para evitar duplicados futuros
      const añoActual = new Date().getFullYear();
      const slugFinal = `${slugBase}-${añoActual}`;

      // 4. Preparamos el objeto para Supabase
      const convocatoria = {
        slug: slugFinal,
        title: item.title,
        // Generamos una meta-descripción cortando el contenido a 150 caracteres
        meta_description: item.contentSnippet
          ? item.contentSnippet.substring(0, 150) + "..."
          : item.title,
        department: "Administración Pública", // Aquí podrías hacer un regex para extraer el ministerio
        type: "Oposición",
        publication_date: new Date(item.pubDate),
        link_boe: item.link,
        raw_text: item.contentSnippet || item.content,
      };

      // 5. Insertamos en la Base de Datos
      // Usamos upsert para que, si el slug ya existe, no de error y simplemente lo actualice o lo ignore
      const { data, error } = await supabase
        .from("convocatorias")
        .upsert(convocatoria, { onConflict: "slug" });

      if (error) {
        console.error(`❌ Error al insertar ${slugFinal}:`, error.message);
      } else {
        nuevasInsertadas++;
      }
    }

    console.log(
      `✅ Proceso completado. ${nuevasInsertadas} convocatorias procesadas.`,
    );

    // Aquí iría el POST al Webhook de Astro (lo añadiremos en el siguiente paso del proyecto)
    // await fetch('URL_DE_VERCEL_O_CLOUDFLARE', { method: 'POST' });
  } catch (error) {
    console.error("🔥 Error crítico en el scraper:", error);
    process.exit(1);
  }
}

extraerBOE();
