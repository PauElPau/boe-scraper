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

// Esta función comprueba si el departamento existe. Si no, lo crea.
async function gestionarDepartamento(nombre) {
  if (!nombre) return;

  // Creamos un slug para el departamento (ej: "ministerio-de-justicia")
  const slugDep = slugify(nombre, { lower: true, strict: true, remove: /[*+~.()'"!:@]/g });

  // Usamos 'upsert' para insertar solo si no existe (basado en el campo 'slug')
  // 'ignoreDuplicates: true' significa que si ya existe, no hace nada (no da error).
  const { error } = await supabase
    .from('departments')
    .upsert({ name: nombre, slug: slugDep }, { onConflict: 'slug', ignoreDuplicates: true });

  if (error) {
    console.error(`⚠️ Error gestionando departamento ${nombre}:`, error.message);
  }
}

// --- NUEVA FUNCIÓN: CLASIFICADOR INTELIGENTE ---
function deducirTipo(titulo) {
  // Pasamos todo a minúsculas y quitamos acentos para que sea más fácil buscar
  const t = titulo.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // 1. Correcciones (Van primero para que no las confunda con convocatorias reales)
  if (t.includes('correccion de error') || t.includes('errata')) {
    return 'Corrección de errores';
  }
  
  // 2. Trámites de Listas
  if (t.includes('admitid') || t.includes('excluid') || t.includes('relacion provisional') || t.includes('relacion definitiva')) {
    return 'Listas de Admitidos/Excluidos';
  }
  
  // 3. Trámites de Exámenes y Notas
  if (t.includes('fecha, hora') || t.includes('lugar de celebracion') || t.includes('ejercicio') || t.includes('calificacion') || t.includes('relacion de aprobad')) {
    return 'Exámenes y Calificaciones';
  }
  
  // 4. Trámites de Tribunales
  if (t.includes('tribunal') || t.includes('organo de seleccion') || t.includes('nombra') && t.includes('miembro')) {
    return 'Tribunales';
  }
  
  // 5. Traslados (Para funcionarios que ya tienen plaza, no para nuevos)
  if (t.includes('provision de puesto') || t.includes('concurso de traslado') || t.includes('concurso especifico')) {
    return 'Concurso de Traslados (Interno)';
  }
  
  // 6. Bolsas de Empleo Temporal
  if (t.includes('bolsa de empleo') || t.includes('bolsa de trabajo') || t.includes('contratacion temporal')) {
    return 'Bolsa de Empleo';
  }
  
  // 7. LAS DESEADAS: Nuevas Convocatorias de Plazas
  // Si tiene palabras de convocatoria y no ha sido atrapada por los filtros anteriores...
  if (t.includes('convoca') || t.includes('plaza') || t.includes('ingreso libre') || t.includes('acceso libre') || t.includes('pruebas selectivas')) {
    return 'Nueva Convocatoria';
  }

  // 8. El cajón desastre
  return 'Otros Trámites';
}

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
      

      // El BOE publica a las 00:00 +0100.
      // Si usamos new Date() directo, Node.js en UTC lo interpreta como las 23:00 del día anterior.
      // Solución: Parseamos manualmente la cadena o forzamos UTC al mediodía para evitar cambios de día.
      const fechaRaw = new Date(item.pubDate);
      fechaRaw.setHours(fechaRaw.getHours() + 12);
      // Ahora sí, extraemos la fecha en formato string YYYY-MM-DD para Supabase
      const fechaCorrecta = fechaRaw.toISOString().split('T')[0];

      // --- NUEVO: EXTRACCIÓN DE CATEGORÍAS Y GUID ---
      // item.categories es un array. 
      // La [0] suele ser la Sección (II. Autoridades...)
      // La [1] suele ser el Organismo (UNIVERSIDADES, MINISTERIOS...)

      // Usamos "||" por seguridad, por si alguna vez vienen vacías
      const categoriaSeccion = item.categories && item.categories[0] ? item.categories[0] : "Otros";
      const categoriaOrganismo = item.categories && item.categories[1] ? item.categories[1] : "Administración Pública";

      // Antes de guardar la oposición, nos aseguramos de que el departamento exista en la tabla maestra
      await gestionarDepartamento(categoriaOrganismo);

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
        section: categoriaSeccion,     
        department: categoriaOrganismo, // (UNIVERSIDADES, etc.)
        guid: item.guid,               
        type: "OPOSICION - " + deducirTipo(item.title),
        publication_date: fechaCorrecta,
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
