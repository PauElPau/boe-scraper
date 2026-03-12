require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const Parser = require("rss-parser");
const slugify = require("slugify");
const { OpenAI } = require("openai");
const { Resend } = require('resend'); 
const cheerio = require("cheerio"); // 👈 VOLVEMOS A AÑADIR CHEERIO PARA EL BOE

// --- 1. INICIALIZACIÓN DE CLIENTES ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

// 💡 SISTEMA MULTI-KEY PARA SALTARSE LOS LÍMITES DE GROQ
const groqKeys = [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2].filter(Boolean);
let currentKeyIndex = 0;

function getGroqClient() {
  return new OpenAI({
    apiKey: groqKeys[currentKeyIndex],
    baseURL: "https://api.groq.com/openai/v1",
  });
}

function rotarKeyGroq() {
  currentKeyIndex++;
  if (currentKeyIndex >= groqKeys.length) {
    console.error("❌ Todas las API Keys de Groq han agotado su cuota diaria.");
    return false; // Ya no quedan llaves
  }
  console.log(`🔄 Cuota agotada. Cambiando a la API Key secundaria de Groq (Key ${currentKeyIndex + 1})...`);
  return true;
}

const parser = new Parser({
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  },
});


// --- 2. CONFIGURACIÓN DE BOLETINES ---
const FUENTES_BOLETINES = [
  // 🟢 BOLETINES CON RSS FUNCIONAL Y VERIFICADO
  { nombre: "BOE", tipo: "rss", url: "https://www.boe.es/rss/boe.php?s=2B", ambito: "Estatal" },
  { nombre: "BOJA", tipo: "rss", url: "https://www.juntadeandalucia.es/boja/distribucion/s52.xml", ambito: "Andalucía" },
  { nombre: "BOPV", tipo: "rss", url: "https://www.euskadi.eus/bopv2/datos/Ultimo.xml", ambito: "País Vasco" },
  { nombre: "BORM", tipo: "rss", url: "https://www.borm.es/rss/boletin.xml", ambito: "Región de Murcia" },
  { nombre: "DOE", tipo: "rss", url: "https://doe.juntaex.es/rss/rss.php?seccion=6", ambito: "Extremadura" },
  { nombre: "DOG", tipo: "rss", url: "https://www.xunta.gal/diario-oficial-galicia/rss/Sumario_es.rss", ambito: "Galicia" },
  { nombre: "BOCM", tipo: "rss", url: "https://www.bocm.es/ultimo-boletin.xml", ambito: "Madrid" },

  // 🌐 BOLETINES SIN RSS (Rastreo de Sumarios HTML vía Cloudflare)
  { nombre: "DOGV", tipo: "html_directo", url: "https://dogv.gva.es/es/inici", ambito: "Comunidad Valenciana" },
  { nombre: "BOPA", tipo: "html_directo", url: "https://sede.asturias.es/bopa", ambito: "Asturias" },
  { nombre: "BON", tipo: "html_directo", url: "https://bon.navarra.es/es/ultimo", ambito: "Navarra" },
  { nombre: "BOR", tipo: "html_directo", url: "https://web.larioja.org/bor-portada", ambito: "La Rioja" },
  
  // 🔄 BOLETINES CON URL ESTABLE (Redirigen solos al número de hoy)
  { nombre: "BOIB", tipo: "html_directo", url: "https://intranet.caib.es/eboibfront/es/ultimo-boletin", ambito: "Islas Baleares" },
  { nombre: "BOC", tipo: "html_directo", url: "https://www.gobiernodecanarias.org/boc/ultimo/", ambito: "Canarias" },
  { nombre: "BOC_CANTABRIA", tipo: "html_directo", url: "https://boc.cantabria.es/boces/ultimo-boletin", ambito: "Cantabria" },
  { nombre: "DOGC", tipo: "html_directo", url: "https://dogc.gencat.cat/es/document-del-dogc/", ambito: "Cataluña" },

 /*  { nombre: "BOIB", tipo: "html_directo", url: "https://www.caib.es/eboibfront/es/2026/12243/seccion-ii-autoridades-y-personal/473", ambito: "Islas Baleares" },
  { nombre: "BOC", tipo: "html_directo", url: "https://www.gobiernodecanarias.org/boc/archivo/2026/049/", ambito: "Canarias" },
  { nombre: "BOC_CANTABRIA", tipo: "html_directo", url: "https://boc.cantabria.es/boces/boletines.do?boton=accesos&id=44185#sec22", ambito: "Cantabria" },
  { nombre: "DOGC", tipo: "html_directo", url: "https://dogc.gencat.cat/es/sumari-del-dogc/?numDOGC=9623", ambito: "Cataluña" }, */

  // 📅 BOLETINES CON FECHA DINÁMICA (El código sustituirá los comodines)
  { nombre: "BOA", tipo: "html_directo", url: "https://www.boa.aragon.es/#/resultados-fecha?from=busquedaFechaHome&PUBL={YYYYMMDD}&SECC-C=BOA%2Bo%2BDisposiciones%2Bo%2BPersonal%2Bo%2BAcuerdos%2Bo%2BJusticia%2Bo%2BAnuncios", ambito: "Aragón" },
  { nombre: "DOCM", tipo: "html_directo", url: "https://docm.jccm.es/docm/cambiarBoletin.do?fecha={YYYYMMDD}", ambito: "Castilla-La Mancha" },
  { nombre: "BOCYL", tipo: "html_directo", url: "https://bocyl.jcyl.es/boletin.do?fechaBoletin={DD/MM/YYYY}#I.B._AUTORIDADES_Y_PERSONAL", ambito: "Castilla y León" }
];

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function gestionarDepartamento(nombre) {
  if (!nombre) return;
  const slugDep = slugify(nombre, { lower: true, strict: true, remove: /[*+~.()'"!:@]/g });
  const { error } = await supabase
    .from('departments')
    .upsert({ name: nombre, slug: slugDep }, { onConflict: 'slug', ignoreDuplicates: true });
  if (error) console.error(`⚠️ Error departamento ${nombre}:`, error.message);
}

// --- 3. EXTRACCIÓN BOE NATIVA (LA VÍA RÁPIDA) ---
async function obtenerTextoBOE(url) {
  try {
    const respuesta = await fetch(url);
    const html = await respuesta.text();
    const $ = cheerio.load(html);
    let textoLimpio = $('#textoxslt').text();
    if (!textoLimpio) textoLimpio = $('body').text(); // Fallback por si cambia la estructura
    textoLimpio = textoLimpio.replace(/\s+/g, ' ').trim();
    return textoLimpio.substring(0, 15000);
  } catch (error) {
    console.error(`⚠️ Error extrayendo el BOE de forma nativa:`, error.message);
    return null; 
  }
}

async function obtenerTextoUniversal(url, reintentos = 3) {
    const MI_CUENTA_ID = "6c06ad7321c0b5e96c5921f94470e05e";
    const MI_TOKEN_API = "j-iMVNZe0JocbS4_ZsGnDkinrKrBv1Fe100t6Z2y";
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${MI_CUENTA_ID}/browser-rendering/markdown`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MI_TOKEN_API}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url: url }) 
    });

  if (response.status === 429) {
      if (reintentos > 0) {
         // Si es el primer reintento (reintentos = 3), espera 3 segundos.
         // Si es el segundo (2), espera 6s. El tercero (1) espera 9s.
         const tiempoPausa = (4 - reintentos) * 3000; 
         console.log(`   ⏳ Límite de Cloudflare. Pausa inteligente de ${tiempoPausa/1000}s...`);
         await esperar(tiempoPausa); 
         return obtenerTextoUniversal(url, reintentos - 1); 
      } else {
         console.error(`❌ Demasiados bloqueos seguidos para la URL: ${url}`);
         return null;
      }
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`⚠️ Cloudflare falló al procesar ${url} - Status: ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    let textoLimpio = data.result || "";
    
    // 💡 AUMENTAMOS EL LÍMITE A 80.000 CARACTERES PARA NO CORTAR EL BOLETÍN
    return typeof textoLimpio === "string" ? textoLimpio.substring(0, 80000) : ""; 
    
  } catch (error) {
    console.error(`⚠️ Fallo de conexión interno para ${url}:`, error.message);
    return null; 
  }
}


// --- 5. MOTORES DE IA ---
async function extraerEnlacesSumarioIA(markdownWeb, nombreBoletin) {
  const prompt = `
    Eres un experto en empleo público. Analiza este sumario/portada del boletín ${nombreBoletin} en Markdown.
    Tu misión es extraer SOLO las resoluciones individuales de convocatorias de empleo (oposiciones, concursos, plazas, estabilización).
    
    REGLAS ESTRICTAS:
    1. IGNORA menús de navegación, cabeceras, pies de página, "cartas de servicios", "pagos" o índices genéricos.
    2. Busca SOLO bajo apartados como "Oposiciones y concursos", "Autoridades y personal", o "Empleo público".
    3. Devuelve el enlace EXACTO que acompaña a cada resolución específica.
    
    Devuelve ÚNICAMENTE un JSON con esta estructura:
    { "convocatorias": [ { "titulo": "...", "enlace": "...", "departamento": "..." } ] }
    Si no hay nada relevante, devuelve { "convocatorias": [] }.
    
    TEXTO:
    ${markdownWeb}
  `;

  try {
    const groq = getGroqClient(); // <-- Usamos el cliente dinámico
    const response = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      temperature: 0.0, // 💡 Bajamos a 0.0 para máxima precisión
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: "You output strict JSON." }, { role: "user", content: prompt }]
    });
    return JSON.parse(response.choices[0].message.content).convocatorias || [];
  } catch (error) {
    // 💡 SI EL ERROR ES POR CUOTA DIARIA (Rate Limit 429)
    if (error.message.includes('429 Rate limit reached') || error.status === 429) {
        if (rotarKeyGroq()) {
            // Si hemos podido cambiar a la llave 2, esperamos 2 segundos y reintentamos esta misma plaza
            await esperar(2000);
            return extraerEnlacesSumarioIA(markdownWeb, nombreBoletin);
        }
    }
    console.error("⚠️ Error IA extrayendo sumario:", error.message);
    return [];
  }
}

async function analizarConvocatoriaIA(titulo, textoInterior) {
  const prompt = `
  Eres un experto en extraer datos del empleo público. Analiza el texto de esta web.
  TÍTULO: ${titulo}
  TEXTO WEB: ${textoInterior}
  
  Devuelve ÚNICAMENTE un objeto JSON válido con esta estructura exacta:
  {
    "tipo": "Uno de estos: 'OPOSICION - Nueva Convocatoria', 'OPOSICION - Convocatoria (Estabilización)', 'OPOSICION - Bolsas de Empleo', 'OPOSICION - Otros Trámites'.",
    "plazas": "Busca cuántas plazas se convocan en total. Convierte letras a números. Devuelve SIEMPRE un Integer. Si es bolsa o no hay, null.",
    "resumen": "Resumen claro de 1-2 frases.",
    "plazo_numero": "Extrae SOLO la cantidad numérica del plazo (ej: 20, 15, 10). Devuelve siempre un número Integer. Si no hay plazo, null.",
    "plazo_tipo": "Extrae SOLO el tipo de días del plazo (ej: 'hábiles', 'naturales', 'meses'). Si no hay plazo, null.",
    "grupo": "Grupo profesional (A1, A2, B, C1, C2, E). Si no se menciona explícitamente, dedúcelo: 'Técnica/Media' -> 'A2', 'Técnica Superior' -> 'A1', 'Administrativa' -> 'C1', 'Auxiliar' -> 'C2', 'Subalterna/Oficios' -> 'E'. Si no se puede deducir, null.",
    "sistema": "REGLA ESTRICTA: Devuelve EXACTAMENTE 'Oposición', 'Concurso-oposición' o 'Concurso'. Si el texto menciona varios para distintas plazas, devuelve 'Concurso-oposición'. Si no, null.",
    "profesiones": "Devuelve siempre un ARRAY de strings con los nombres limpios de los puestos. Si hay varios, sepáralos como elementos (ej: ['Técnico en Turismo', 'Oficial Tallista']). Si solo hay uno, devuélvelo en el array (ej: ['Policía Local']). Si no hay, devuelve un array vacío [].",
    "provincia": "Provincia deducida (ej: 'Madrid'). Si es Ministerio, 'Estatal'.",
    "titulacion": "Titulación mínima exigida. Si no se menciona, null.",
    "enlace_inscripcion": "URL exacta para presentar instancia. Si no, null.",
    "tasa": "Importe de la tasa. Si no, null.",
    "boletin_origen_nombre": "Si menciona que las bases íntegras están publicadas en otro boletín, extrae SOLO el nombre de ese boletín (ej: 'BOP Córdoba', 'DOGV'). Si no lo menciona, null.",
    "boletin_origen_fecha": "Si menciona la fecha de publicación de ese otro boletín de origen, devuélvela en formato estricto 'YYYY-MM-DD' (ej: '2026-02-17'). Si no, null.",
    "referencia_boe_original": "Si esto es un trámite posterior, busca el código BOE original (BOE-A-YYYY-XXXX). Si no, null.",
    "organismo": "Nombre exacto del ayuntamiento, diputación u organismo (ej: 'Ayuntamiento de Madrid'). Si no lo encuentras, null.",
    "texto_limpio": "Extrae el texto oficial limpio. Elimina menús de navegación, enlaces rotos y basura visual.",
    "meta_description": "Crea una descripción corta (máx 150 caracteres) directa al grano, ideal para SEO. Ejemplo: 'Convocatoria para proveer 3 plazas de Policía Local en el Ayuntamiento de Madrid.'"
  }
  `;

  try {
    const groq = getGroqClient(); // <-- Usamos el cliente dinámico
    const response = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      temperature: 0.1, 
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You output strict JSON. Eres un experto analista legal. Tu prioridad es estructurar datos: extrae números enteros para plazos y plazas, y formatea fechas como YYYY-MM-DD." }, 
        { role: "user", content: prompt }
      ]
    });
    return JSON.parse(response.choices[0].message.content);
  } catch (error) {
    // 💡 SI EL ERROR ES POR CUOTA DIARIA (Rate Limit 429)
    if (error.message.includes('429 Rate limit reached') || error.status === 429) {
        if (rotarKeyGroq()) {
            // Si hemos podido cambiar a la llave 2, esperamos 2 segundos y reintentamos esta misma plaza
            await esperar(2000);
            return analizarConvocatoriaIA(titulo, textoInterior);
        }
    }
    console.error("⚠️ Error con IA analizando detalle:", error.message);
    return { tipo: "OPOSICION - Otros Trámites", plazas: null, resumen: titulo };
  }
}

// --- 6. LÓGICA DE BASE DE DATOS (SUPABASE) ---
async function procesarYGuardarConvocatoria(itemData, textoParaIA, fuente, convocatoriasInsertadasHoy) {
  if (!textoParaIA || textoParaIA.length < 150) {
      console.log(`   ⏭️ Ignorado: El texto extraído es demasiado corto.`);
      return;
  }
  
  const textoLower = textoParaIA.toLowerCase();
  if (textoLower.includes("error 404") || textoLower.includes("página no encontrada") || textoLower.includes("page not found")) {
      console.log(`   ⏭️ Ignorado: La web de destino devolvió un Error 404.`);
      return;
  }

  const analisisIA = await analizarConvocatoriaIA(itemData.title, textoParaIA);

  // 💡 NUEVO: Sacamos la primera profesión del array para usarla como "Principal"
  const profesionPrincipal = (analisisIA.profesiones && analisisIA.profesiones.length > 0) ? analisisIA.profesiones[0] : null;
  
  if (!analisisIA.profesion && !analisisIA.plazas && analisisIA.tipo === "OPOSICION - Otros Trámites") {
      console.log(`   ⏭️ Ignorado: La IA determinó que no es empleo público real.`);
      return;
  }

  // 💡 AQUÍ ESTÁ LA MAGIA: Usamos el organismo exacto de la IA (Ej: "Ayuntamiento de Pals") 
  // Si la IA falla, usamos el genérico del RSS como plan B.
  const departamentoFinal = analisisIA.organismo || itemData.department;

  let parentSlug = null;
  const esTramite = (analisisIA.tipo === 'OPOSICION - Otros Trámites');

  // 🧠 CEREBRO DE DESDUPLICACIÓN CORREGIDO
 if (profesionPrincipal && departamentoFinal) {
    const { data: coincidencias } = await supabase
      .from('convocatorias')
      .select('slug, type, link_boe')
      // Buscamos por el departamento REAL, no por la categoría genérica
      .ilike('department', `%${departamentoFinal}%`)
      .ilike('profesion', `%${profesionPrincipal}%`) // <-- CAMBIO AQUÍ
      .is('parent_slug', null) 
      .order('created_at', { ascending: false }) 
      .limit(1);

    if (coincidencias && coincidencias.length > 0) {
      const plazaExistente = coincidencias[0];

      if (esTramite) {
        console.log(`   🔗 Novedad detectada para la plaza: ${plazaExistente.slug}. Enlazando como trámite hijo...`);
        parentSlug = plazaExistente.slug;
      } 
      else {
        console.log(`   🔄 ¡Duplicado evitado! Esta plaza ya se rastreó antes: ${plazaExistente.slug}`);
        if (fuente.nombre === "BOE" && !plazaExistente.link_boe) {
            console.log(`   ✅ Actualizando la plaza original con la apertura oficial de plazos en el BOE.`);
            await supabase.from("convocatorias").update({ 
                link_boe: itemData.link, 
                publication_date: new Date().toISOString().split('T')[0] 
            }).eq('slug', plazaExistente.slug);
        }
        return; 
      }
    }
  }

  if (!parentSlug && analisisIA.referencia_boe_original) {
    const { data: parentMatch } = await supabase.from('convocatorias').select('slug')
      .like('link_boe', `%${analisisIA.referencia_boe_original}%`).single();
    if (parentMatch) {
        parentSlug = parentMatch.slug;
        console.log(`   🔗 Enlazado por código BOE al padre: ${parentSlug}`);
    }
  }

  // Generamos el slug usando el departamento REAL
let textoParaSlug = profesionPrincipal ? `oposiciones-${analisisIA.plazas ? analisisIA.plazas + '-plazas-' : ''}${profesionPrincipal}-${departamentoFinal}` : (analisisIA.resumen || itemData.title);  let slugBase = slugify(textoParaSlug, { lower: true, strict: true, remove: /[*+~.()'"!:@,]/g });
  if (slugBase.length > 80) slugBase = slugBase.substring(0, 80).replace(/-+$/, '');
  
  const suffix = itemData.guid ? itemData.guid.split('=').pop().replace(/\W/g, '').substring(0,6) : new Date().getTime().toString().slice(-6);
  const slugFinal = `${slugBase}-${suffix}`;

const convocatoria = {
    slug: slugFinal, 
    title: itemData.title, 
    meta_description: analisisIA.meta_description || (analisisIA.resumen ? analisisIA.resumen.substring(0, 150) + "..." : "Ver detalles."),
    section: itemData.section, 
    department: departamentoFinal, 
    guid: itemData.link, 
    parent_type: "OPOSICION", 
    type: analisisIA.tipo, 
    plazas: analisisIA.plazas, 
    resumen: analisisIA.resumen, 
    
    // 💡 LAS 4 COLUMNAS NUEVAS DE ESTRUCTURACIÓN
    plazo_numero: analisisIA.plazo_numero,
    plazo_tipo: analisisIA.plazo_tipo,
    boletin_origen_nombre: analisisIA.boletin_origen_nombre,
    boletin_origen_fecha: analisisIA.boletin_origen_fecha,
    
    // 💡 Mantenemos las columnas antiguas autogeneradas por si tu web aún las usa
    plazo_texto: (analisisIA.plazo_numero && analisisIA.plazo_tipo) ? `${analisisIA.plazo_numero} días ${analisisIA.plazo_tipo}` : null,
    referencia_bases: (analisisIA.boletin_origen_nombre && analisisIA.boletin_origen_fecha) ? `${analisisIA.boletin_origen_nombre} | ${analisisIA.boletin_origen_fecha}` : null,

    grupo: analisisIA.grupo, 
    sistema: analisisIA.sistema, 
    // Guardamos la principal para retrocompatibilidad
    profesion: profesionPrincipal, 
    // Guardamos el ARRAY completo para el buscador de tu web
    profesiones: analisisIA.profesiones,
    provincia: analisisIA.provincia || fuente.ambito, 
    titulacion: analisisIA.titulacion, 
    enlace_inscripcion: analisisIA.enlace_inscripcion, 
    tasa: analisisIA.tasa,
    parent_slug: parentSlug, 
    publication_date: new Date().toISOString().split('T')[0], 
    link_boe: itemData.link, 
    raw_text: analisisIA.texto_limpio || textoParaIA,
  };

  const { data, error } = await supabase.from("convocatorias").upsert(convocatoria, { onConflict: "slug" }).select();
  
  if (error) {
    console.error(`❌ Error BD:`, error.message);
  } else {
    // 💡 Aseguramos que el departamento se guarde también en tu tabla 'departments'
    await gestionarDepartamento(departamentoFinal);
    
    console.log(`✅ Guardado -> ${fuente.nombre} | Tipo: ${analisisIA.tipo} | Org: ${departamentoFinal}`);
    if (data && data.length > 0) convocatoriasInsertadasHoy.push(data[0]);
  }
}
// --- 7. SISTEMAS DE ALERTAS (ORIGINALES) ---
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
              <p style="font-size: 16px;">Nuevas publicaciones que coinciden con tu alerta de <strong>"${sub.interes}"</strong>:</p>
              <ul style="list-style: none; padding: 0;">${htmlLista}</ul>
              <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 30px 0 20px 0;" />
              <p style="font-size: 12px; text-align: center;"><a href="${enlaceBaja}" style="color: #94a3b8;">Cancelar suscripción</a></p>
            </div>
          `
        });
        await esperar(1000); 
      } catch (err) {
        console.error(`❌ Error enviando email a ${sub.email}:`, err);
      }
    }
  }
}

async function enviarAlertasFavoritos(nuevasConvocatorias) {
  const actualizaciones = nuevasConvocatorias.filter(c => c.parent_slug);

  if (actualizaciones.length === 0) return;
  if (!process.env.RESEND_API_KEY) return;

  const resend = new Resend(process.env.RESEND_API_KEY);
  console.log(`🔔 Se han detectado ${actualizaciones.length} actualizaciones de trámites. Buscando seguidores...`);

  for (const update of actualizaciones) {
    const { data: seguidores, error } = await supabase
      .from('favoritos')
      .select('user_id')
      .eq('convocatoria_slug', update.parent_slug);
    
    if (error || !seguidores || seguidores.length === 0) continue;

    console.log(`   -> La actualización '${update.title.substring(0, 30)}...' tiene ${seguidores.length} seguidores.`);

    for (const seguidor of seguidores) {
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
                <p style="font-size: 16px;">Acabamos de detectar un nuevo trámite oficial para la plaza que tienes guardada en favoritos.</p>
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
          await esperar(1000); 
        } catch (err) {
          console.error(`      ❌ Error enviando novedad a ${email}:`, err);
        }
      }
    }
  }
}

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
  let texto = `🚨 *¡Nuevas Oposiciones!* 🚨\n\nHoy se han publicado *${convocatoriasReales.length}* nuevas oportunidades:\n\n`;

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

// --- 8. BUCLE PRINCIPAL ---
async function extraerBoletines() {
  try {
    const convocatoriasInsertadasHoy = [];

    for (const fuente of FUENTES_BOLETINES) {
      console.log(`\n==============================================`);
      console.log(`📡 Rastreando ${fuente.nombre} (${fuente.ambito}) - Modo: ${fuente.tipo}`);
      console.log(`==============================================`);
      
      try {
        if (fuente.tipo === "rss") {
          const feed = await parser.parseURL(fuente.url);
          for (const item of feed.items.reverse()) {
            const t = item.title.toLowerCase();
            if (!t.includes('oposición') && !t.includes('concurso') && !t.includes('provisión') && !t.includes('empleo') && !t.includes('plaza') && !t.includes('bolsa')) continue;

            const categoriaSeccion = item.categories?.[0] || `Boletín ${fuente.nombre}`;
            const categoriaOrganismo = item.categories?.[1] || fuente.ambito;
            await gestionarDepartamento(categoriaOrganismo);

            console.log(`\n📄 Extrayendo interior de: ${item.title.substring(0,60)}...`);
            
            let textoParaIA = null;
            // 💡 AQUÍ ESTÁ EL ARREGLO:
            if (fuente.nombre === "BOE") {
              // Usamos tu función rápida y nativa para el BOE (salta bloqueos)
              textoParaIA = await obtenerTextoBOE(item.link);
            } else {
              // Cloudflare para los RSS más complejos
              textoParaIA = await obtenerTextoUniversal(item.link);
            }
            
            // Si por cualquier motivo falla, nos quedamos con el Snippet
            if (!textoParaIA || textoParaIA.length < 50) {
              textoParaIA = item.contentSnippet || item.content;
            }
            
            await procesarYGuardarConvocatoria({ 
              title: item.title, link: item.link, section: categoriaSeccion, department: categoriaOrganismo 
            }, textoParaIA, fuente, convocatoriasInsertadasHoy);
            
            await esperar(500);
          }
        } 
        
        else if (fuente.tipo === "html_directo") {
          // 💡 CALCULAMOS LA FECHA DE HOY PARA LAS URLs DINÁMICAS
          const hoy = new Date();
          const yyyy = hoy.getFullYear();
          const mm = String(hoy.getMonth() + 1).padStart(2, '0');
          const dd = String(hoy.getDate()).padStart(2, '0');
          
          let urlFinal = fuente.url
            .replace('{YYYYMMDD}', `${yyyy}${mm}${dd}`)
            .replace('{DD/MM/YYYY}', `${dd}/${mm}/${yyyy}`);

          const markdownWeb = await obtenerTextoUniversal(urlFinal); // Usamos urlFinal
          if (!markdownWeb) continue;

          console.log(`🤖 Buscando enlaces de empleo en el sumario de ${fuente.nombre}...`);
          const listado = await extraerEnlacesSumarioIA(markdownWeb, fuente.nombre);
          
          if (listado.length > 0) {
              console.log(`✅ Encontradas ${listado.length} posibles convocatorias.`);
          } else {
              console.log(`ℹ️ Hoy no se ha encontrado empleo público en este boletín.`);
          }

          for (const item of listado) {
            // 💡 1. Filtramos basura evidente que la IA haya colado
            const t = item.titulo.toLowerCase();
            if (t.includes('carta de servicios') || t.includes('pago de anuncios') || t.includes('publicar en')) {
               continue;
            }

            // 💡 2. Convertimos enlaces relativos (#/ruta o /ruta) a absolutos (https://...)
            let enlaceFinal = item.enlace;
            try {
               enlaceFinal = new URL(item.enlace, fuente.url).href;
            } catch (e) {
               console.log(`⚠️ Enlace mal formado ignorado: ${item.enlace}`);
               continue;
            }
            
            // Si el enlace es idéntico a la portada, es un error de la IA, lo saltamos
            if (enlaceFinal === fuente.url || enlaceFinal === fuente.url + '/') continue;

            await gestionarDepartamento(item.departamento);
            
            console.log(`\n📄 Extrayendo interior de: ${item.titulo.substring(0,60)}...`);
            let textoInterior = await obtenerTextoUniversal(enlaceFinal);
            if(!textoInterior) continue;

            await procesarYGuardarConvocatoria({ 
              title: item.titulo, link: enlaceFinal, section: `Boletín ${fuente.nombre}`, department: item.departamento 
            }, textoInterior, fuente, convocatoriasInsertadasHoy);
            
            await esperar(500);
          }
        }
      } catch (err) {
        console.error(`❌ Error procesando ${fuente.nombre}:`, err.message);
      }
    }

    console.log(`\n🎉 RASTREO COMPLETADO. Total nuevas insertadas: ${convocatoriasInsertadasHoy.length}`);
    
  /*   if (convocatoriasInsertadasHoy.length > 0) {
      await enviarAlertasPorEmail(convocatoriasInsertadasHoy);
      await enviarAlertasFavoritos(convocatoriasInsertadasHoy);
      await enviarAlertaTelegram(convocatoriasInsertadasHoy);
    } */

    if (process.env.VERCEL_WEBHOOK && convocatoriasInsertadasHoy.length > 0) {
      await fetch(process.env.VERCEL_WEBHOOK, { method: 'POST' });
    }

  } catch (error) {
    console.error("🔥 Error crítico general:", error);
    process.exit(1);
  }
}

// ¡Ejecutar!
extraerBoletines();