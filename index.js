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

// --- NUEVA FUNCIÓN: EXTRACTOR DE PLAZAS ---
function extraerPlazas(titulo) {
  const t = titulo.toLowerCase();
  
  // Si es una bolsa de empleo o lista de reserva, el número de plazas es indeterminado (null)
  if (t.includes('bolsa') || t.includes('lista de reserva')) {
    return null; 
  }

  // 1er Intento: Buscar números en formato dígito (ej: "3 plazas", "150 puestos", "1 plaza")
  // La expresión regular (\d+) captura cualquier bloque de números que vaya seguido de " plaza" o " puesto"
  const matchDigitos = t.match(/(\d+)\s+(?:plaza|puesto)/);
  if (matchDigitos && matchDigitos[1]) {
    return parseInt(matchDigitos[1], 10);
  }

  // 2º Intento: El BOE usa muchísimo la palabra "una" o "un" en lugar del número 1. (ej: "una plaza")
  const matchUna = t.match(/(?:un|una|uno)\s+(?:plaza|puesto)/);
  if (matchUna) {
    return 1;
  }

  // 3er Intento: Números del 2 al 10 escritos con letras (menos común, pero ocurre)
  const numerosTexto = {
    'dos': 2, 'tres': 3, 'cuatro': 4, 'cinco': 5, 
    'seis': 6, 'siete': 7, 'ocho': 8, 'nueve': 9, 'diez': 10
  };
  
  for (const [palabra, numero] of Object.entries(numerosTexto)) {
    if (t.match(new RegExp(`${palabra}\\s+(?:plaza|puesto)`))) {
      return numero;
    }
  }

  // Si no encuentra nada claro, devolvemos null
  return null;
}

// --- NUEVA FUNCIÓN: CLASIFICADOR INTELIGENTE ---
function deducirTipo(titulo) {
  // Pasamos todo a minúsculas, quitamos acentos y caracteres raros
  const t = titulo.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // 1. CORRECCIONES Y ANULACIONES (Van primero para que atrapen cualquier cambio sobre trámites posteriores)
  if (t.includes('correccion') || t.includes('errata') || t.includes('modifica') || t.includes('ampliacion de plazo') || t.includes('deja sin efecto') || t.includes('desierto') || t.includes('suspension') || t.includes('retrotrae')) {
    return 'Correcciones y Modificaciones';
  }

  // 2. ADJUDICACIONES, APROBADOS Y NOMBRAMIENTOS (El final del proceso)
  // Atrapa a la gente que ya ha ganado la plaza o elige destino.
  if (t.includes('aprobad') || t.includes('destino') || t.includes('adjudicacion') || t.includes('superan') || t.includes('fase de practica') || (t.includes('nombra') && t.includes('funcionari'))) {
    return 'Aprobados y Adjudicaciones';
  }

  // 3. TRÁMITES: ADMITIDOS Y EXCLUIDOS
  if (t.includes('admitid') || t.includes('excluid') || t.includes('relacion provisional') || t.includes('relacion definitiva') || t.includes('lista provisional')) {
    return 'Listas de Admitidos/Excluidos';
  }

  // 4. TRÁMITES: EXÁMENES Y NOTAS
  if (t.includes('fecha') || t.includes('hora') || t.includes('lugar') || t.includes('ejercicio') || t.includes('calificacion') || t.includes('fase de concurso') || t.includes('fase de oposicion') || t.includes('valoracion') || t.includes('prueba de aptitud')) {
    return 'Exámenes y Calificaciones';
  }

  // 5. TRÁMITES: TRIBUNALES
  if (t.includes('tribunal') || t.includes('organo de seleccion') || t.includes('comision de seleccion') || t.includes('comision calificador') || t.includes('comision evaluadora') || (t.includes('nombra') && t.includes('miembro'))) {
    return 'Tribunales';
  }

  // 6. TRASLADOS Y LIBRE DESIGNACIÓN (Movilidad para quienes YA son funcionarios)
  // "Libre designación" ensucia muchísimo el BOE. Hay que aislarlo.
  if (t.includes('libre designacion') || t.includes('provision de puesto') || t.includes('concurso de traslado') || t.includes('concurso especifico') || t.includes('concurso general')) {
    return 'Traslados / Libre Designación';
  }

  // 7. BOLSAS DE EMPLEO TEMPORAL Y SUSTITUCIONES
  if (t.includes('bolsa de empleo') || t.includes('bolsa de trabajo') || t.includes('lista de reserva') || t.includes('contratacion temporal') || t.includes('interin')) {
    return 'Bolsas de Empleo';
  }

  // 8. LAS DESEADAS: NUEVAS CONVOCATORIAS
  // Si tiene palabras clave de inicio de proceso y ha sobrevivido a los filtros anteriores, es una convocatoria.
  if (t.includes('convoca') || t.includes('plaza') || t.includes('ingreso') || t.includes('acceso libre') || t.includes('pruebas selectivas') || t.includes('proceso selectivo')) {
    
    // Sub-Clasificamos las convocatorias para dar una información brutal al usuario
    if (t.includes('promocion interna')) {
        return 'Convocatoria (Promoción Interna)';
    }
    if (t.includes('estabilizacion') || t.includes('consolidacion')) {
        return 'Convocatoria (Estabilización)';
    }
    
    // Si no es interna ni de estabilización, es el Santo Grial:
    return 'Nueva Convocatoria'; 
  }

  // 9. CAJÓN DESASTRE (Cartas de servicios, convenios raros, etc.)
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
        parent_type: "OPOSICION",    
        plazas: extraerPlazas(item.title),
        type: deducirTipo(item.title),
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
