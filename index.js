require("dotenv").config();
// 🛡️ ESCUDO ANTI-CERTIFICADOS CADUCADOS
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { createClient } = require("@supabase/supabase-js");
const Parser = require("rss-parser");
const slugify = require("slugify");
const { OpenAI } = require("openai");
const { Resend } = require('resend'); 
const cheerio = require("cheerio"); 

// --- 1. INICIALIZACIÓN DE CLIENTES ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

const groqKeys = [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2].filter(Boolean);
let currentKeyIndex = 0;
let iaDetenida = false; 

function getGroqClient() {
  return new OpenAI({
    apiKey: groqKeys[currentKeyIndex],
    baseURL: "https://api.groq.com/openai/v1",
  });
}

function rotarKeyGroq() {
  currentKeyIndex++;
  if (currentKeyIndex >= groqKeys.length || !groqKeys[currentKeyIndex]) {
    console.error("❌ Todas las API Keys de Groq han agotado su cuota. Apagando motores por hoy.");
    iaDetenida = true; 
    return false; 
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
//  { nombre: "BOE", tipo: "rss", url: "https://www.boe.es/rss/boe.php?s=2B", ambito: "Estatal" },
//  { nombre: "BOJA", tipo: "rss", url: "https://www.juntadeandalucia.es/boja/distribucion/s52.xml", ambito: "Andalucía" },
//  { nombre: "BOPV", tipo: "rss", url: "https://www.euskadi.eus/bopv2/datos/Ultimo.xml", ambito: "País Vasco" },
//  { nombre: "BORM", tipo: "rss", url: "https://www.borm.es/rss/boletin.xml", ambito: "Región de Murcia" },
//  { nombre: "DOE", tipo: "rss", url: "https://doe.juntaex.es/rss/rss.php?seccion=6", ambito: "Extremadura" },
//  { nombre: "DOG", tipo: "rss", url: "https://www.xunta.gal/diario-oficial-galicia/rss/Sumario_es.rss", ambito: "Galicia" },
//  { nombre: "BOCM", tipo: "rss", url: "https://www.bocm.es/ultimo-boletin.xml", ambito: "Madrid" },

 // { nombre: "DOGV", tipo: "html_directo", url: "https://sede.gva.es/es/novetats-ocupacio-publica?fecha={DD}%2F{MM}%2F{YYYY}", ambito: "Comunidad Valenciana" },
  // { nombre: "BOIB", tipo: "html_directo", url: "https://www.caib.es/eboibfront/indexrss.do?lang=es", ambito: "Islas Baleares", rssToHtml: true },
  { nombre: "BOPA", tipo: "html_directo", url: "https://sede.asturias.es/bopa", ambito: "Asturias" },
  { nombre: "BON", tipo: "html_directo", url: "https://bon.navarra.es/es/ultimo", ambito: "Navarra" },
  { nombre: "BOR", tipo: "html_directo", url: "https://web.larioja.org/bor-portada", ambito: "La Rioja" },
  

  { nombre: "BOC", tipo: "html_directo", url: "https://www.gobiernodecanarias.org/boc/ultimo/", ambito: "Canarias" },  
  { nombre: "BOC_CANTABRIA", tipo: "html_directo", url: "https://boc.cantabria.es/boces/ultimo-boletin", ambito: "Cantabria" },  
  { nombre: "DOGC", tipo: "html_directo", url: "https://dogc.gencat.cat/es/inici/resultats/index.html?orderBy=3&page=1&typeSearch=1&advanced=true&current=true&title=true&numResultsByPage=50&publicationDateInitial={DD/MM/YYYY}&thematicDescriptor=D4090&thematicDescriptor=DE1738", ambito: "Cataluña" },

 // { nombre: "BOA", tipo: "html_directo", url: "https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI?CMD=VERLST&BASE=BZHT&DOCS=1-250&SEC=OPENDATABOAJSONAPP&OUTPUTMODE=JSON&SEPARADOR=&PUBL-C={YYYYMMDD}&SECC-C=BOA%2Bo%2BDisposiciones%2Bo%2BPersonal%2Bo%2BAcuerdos%2Bo%2BJusticia%2Bo%2BAnuncios", ambito: "Aragón" },
  //{ nombre: "DOCM", tipo: "html_directo", url: "https://docm.jccm.es/docm/cambiarBoletin.do?fecha={YYYYMMDD}", ambito: "Castilla-La Mancha" },
 // { nombre: "BOCYL", tipo: "html_directo", url: "https://bocyl.jcyl.es/boletin.do?fechaBoletin={DD/MM/YYYY}#I.B._AUTORIDADES_Y_PERSONAL", ambito: "Castilla y León" }
];

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function calcularFechaCierre(fechaPublicacion, plazoNumero, plazoTipo) {
  if (!plazoNumero || !plazoTipo || !fechaPublicacion) return null;
  const fechaBase = new Date(fechaPublicacion);
  fechaBase.setDate(fechaBase.getDate() + 1);
  let fechaCierre = new Date(fechaBase);
  const tipo = plazoTipo.toLowerCase();
  try {
    if (tipo.includes('hábil') || tipo.includes('habil')) {
      let diasSumados = 0;
      fechaCierre.setDate(fechaCierre.getDate() - 1); 
      while (diasSumados < plazoNumero) {
          fechaCierre.setDate(fechaCierre.getDate() + 1);
          const diaSemana = fechaCierre.getDay();
          if (diaSemana !== 0 && diaSemana !== 6) diasSumados++;
      }
    } 
    else if (tipo.includes('natural') || tipo.includes('día') || tipo.includes('dia')) {
      fechaCierre.setDate(fechaCierre.getDate() + plazoNumero - 1);
    } 
    else if (tipo.includes('mes')) {
      fechaCierre.setMonth(fechaCierre.getMonth() + plazoNumero);
      fechaCierre.setDate(fechaCierre.getDate() - 1); 
    } 
    else return null;
    return fechaCierre.toISOString().split('T')[0];
  } catch (error) { return null; }
}

function limpiarCodificacion(texto) {
  if (!texto) return texto;
  let limpio = texto.replace(/\\u([\dA-Fa-f]{4})/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
  return limpio.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}

async function gestionarDepartamento(nombre) {
  if (!nombre) return;
  const slugDep = slugify(nombre, { lower: true, strict: true, remove: /[*+~.()'"!:@]/g });
  await supabase.from('departments').upsert({ name: nombre, slug: slugDep }, { onConflict: 'slug', ignoreDuplicates: true });
}

// 🛡️ MEJORA: Escudo Anti-Geobloqueo (Si Github desde EE.UU. es bloqueado, usamos Proxy)
async function obtenerTextoNativo(url) {
  let html = "";
  try {
    const respuesta = await fetch(url, {
        headers: { 
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "es-ES,es;q=0.9"
        }
    });
    html = await respuesta.text();
  } catch (error) {
    console.log(`   ⚠️ Fallo de red detectado (Posible geobloqueo). Activando Proxy Público...`);
    try {
      // Plan C: Usamos AllOrigins para saltar el bloqueo de IP a servidores de EE.UU.
      const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
      const resProxy = await fetch(proxyUrl);
      if (!resProxy.ok) throw new Error("Proxy denegado");
      html = await resProxy.text();
    } catch (e2) {
      console.error(`   ❌ Imposible acceder a la web ni con proxy: ${url}`);
      return { texto: null, pdf: null }; 
    }
  }

  // Parseamos el HTML obtenido (sea por vía directa o por proxy)
  const $ = cheerio.load(html);
  let pdfLink = null;
  $('a').each((i, el) => {
      const href = $(el).attr('href');
      if (href && (href.toLowerCase().includes('.pdf') || href.toLowerCase().includes('descargararchivo') || href.toLowerCase().includes('document-del-dogc'))) {
          try { pdfLink = new URL(href, url).href; } catch(e){}
          return false; 
      }
  });

  $('script, style, nav, footer, header, aside').remove();
  let textoLimpio = $('#textoxslt').text(); 
  if (!textoLimpio) textoLimpio = $('body').text(); 
  
  textoLimpio = textoLimpio.replace(/\s+/g, ' ').trim();
  return { texto: textoLimpio.substring(0, 15000), pdf: pdfLink };
}

async function obtenerTextoUniversal(url, reintentos = 3) {
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering/markdown`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url: url }) 
    });

    if (response.status === 429) {
      if (reintentos > 0) {
         const tiempoPausa = (4 - reintentos) * 5000; 
         console.log(`   ⏳ Límite de Cloudflare (429). Pausa de ${tiempoPausa/1000}s...`);
         await esperar(tiempoPausa); 
         return obtenerTextoUniversal(url, reintentos - 1); 
      } else {
         console.log(`   ❌ Cloudflare agotó los reintentos para la URL: ${url}`);
         return null;
      }
    }

    if (response.status === 422 || response.status === 403 || response.status === 400) {
      console.log(`   ⚠️ Cloudflare bloqueado (Status ${response.status}). Activando Plan B (Vía Nativa)...`);
      const nativo = await obtenerTextoNativo(url);
      return nativo.texto;
    }

    if (!response.ok) return null;
    
    const data = await response.json();
    let textoLimpio = data.result || "";
    return typeof textoLimpio === "string" ? textoLimpio.substring(0, 80000) : ""; 
  } catch (error) {
    return null; 
  }
}

// --- 5. MOTORES DE IA ---
async function extraerEnlacesSumarioIA(markdownWeb, nombreBoletin) {
  const prompt = `
    Eres un experto en empleo público. Analiza este sumario/portada del boletín ${nombreBoletin} en Markdown.
    Tu misión es extraer SOLO las resoluciones individuales de convocatorias de empleo (oposiciones, concursos, plazas, bolsas, estabilización, libre designación).
    
    REGLAS ESTRICTAS:
    1. IGNORA menús de navegación, cabeceras, convenios colectivos, acuerdos de empresas y "cartas de servicios".
    2. IGNORA CUALQUIER RESOLUCIÓN CUYA FECHA SEA DE AÑOS ANTERIORES.
    3. Busca bajo CUALQUIER apartado que indique empleo, ya sea autonómico, local o estatal. Ejemplos válidos: "Oposiciones", "Entidades locales", "Administración local", "Sector público", "Autoridades y personal", "Ayuntamientos", "Novedades".
    4. Devuelve la URL EXACTA que acompaña a cada resolución específica.
    5. MUY IMPORTANTE: Ignora los enlaces que sean anclas internas de la misma página (que contengan "#" o "sumari"). Busca el enlace real al documento individual o al PDF (suele contener "document-del-dogc", "pdf" o enlazar a un detalle).
    6. DEDUCCIÓN DEL DEPARTAMENTO: Si la resolución está debajo del nombre de un municipio (ejemplo: debajo de "ELX/ELCHE", "PETRER" o "SAX"), el departamento DEBE SER "Ayuntamiento de [Nombre del Municipio]".
    
    Devuelve ÚNICAMENTE un JSON con esta estructura:
    { "convocatorias": [ { "titulo": "...", "enlace": "...", "departamento": "..." } ] }
    Si no hay nada relevante, devuelve { "convocatorias": [] }.
    
    TEXTO:
    ${markdownWeb}
  `;

  try {
    const groq = getGroqClient(); 
    const response = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      temperature: 0.0, 
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: "You output strict JSON." }, { role: "user", content: prompt }]
    });
    return JSON.parse(response.choices[0].message.content).convocatorias || [];
  } catch (error) {
    if (error.message.includes('429 Rate limit reached') || error.status === 429) {
        if (rotarKeyGroq()) {
            await esperar(2000);
            return extraerEnlacesSumarioIA(markdownWeb, nombreBoletin);
        }
    }
    return [];
  }
}

async function analizarConvocatoriaIA(titulo, textoInterior) {
  const prompt = `
  Eres un experto en extraer datos del empleo público. Analiza el texto de esta web.
  TÍTULO: ${titulo}
  TEXTO WEB: ${textoInterior}
  
  ⚠️ REGLA CRÍTICA: Si encuentras información contradictoria o no estás seguro, usa null. SIEMPRE debes devolver un JSON sintácticamente válido.
  
  Devuelve ÚNICAMENTE un objeto JSON válido con esta estructura exacta:
  {
    "tipo": "Clasifica el texto en UNA de estas categorías: 'Oposiciones (Turno Libre)', 'Estabilización y Promoción', 'Bolsas de Empleo Temporal', 'Traslados y Libre Designación', 'Listas de Admitidos/Excluidos', 'Exámenes y Tribunales', 'Aprobados y Adjudicaciones', 'Correcciones y Modificaciones', 'Otros Trámites'. SI EL TEXTO ES UN CONVENIO COLECTIVO, AYUDA O SUBVENCIÓN, devuelve EXACTAMENTE 'IGNORAR'.",
    "plazas": "Busca cuántas plazas se convocan en total. Convierte letras a números. Devuelve SIEMPRE un Integer. Si es bolsa o no hay, null.",
    "resumen": "Resumen claro de 1-2 frases.",
    "plazo_numero": "Extrae SOLO la cantidad numérica del plazo (ej: 20, 15, 10). Devuelve siempre un número Integer. Si no hay plazo, null.",
    "plazo_tipo": "Extrae SOLO el tipo de días del plazo (ej: 'hábiles', 'naturales', 'meses'). Si no hay plazo, null.",
    "grupo": "REGLA MUY ESTRICTA: Devuelve ÚNICAMENTE y EXACTAMENTE uno de estos valores: 'A1', 'A2', 'B', 'C1', 'C2', o 'E'. ¡NUNCA devuelvas descripciones! Si el texto dice 'Técnica Superior' devuelve 'A1'. Si dice 'Técnica/Media' devuelve 'A2'. Si dice 'Administrativa' devuelve 'C1'. Si dice 'Auxiliar' devuelve 'C2'. Si dice 'Subalterna', 'Peón' o 'Oficios' devuelve 'E'. Si no se menciona, devuelve null.",
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
    "meta_description": "Crea una descripción corta (máx 150 caracteres) directa al grano, ideal para SEO. Ejemplo: 'Convocatoria para proveer 3 plazas de Policía Local en el Ayuntamiento de Madrid.'",
    "enlace_pdf": "Busca en el texto la URL directa al documento oficial en formato PDF. En los boletines autonómicos suele ser un enlace explícito de descarga. Si lo encuentras, devuélvelo. Si no hay ningún enlace a un PDF, devuelve null.",
  }
  `;

 
  try {
    const groq = getGroqClient(); 
    const response = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      temperature: 0.1, 
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: "You output strict JSON. Extrae números enteros para plazos." }, { role: "user", content: prompt }]
    });
    return JSON.parse(response.choices[0].message.content);
  } catch (error) {
    if (error.message.includes('429 Rate limit reached') || error.status === 429) {
        if (rotarKeyGroq()) {
            await esperar(2000);
            return analizarConvocatoriaIA(titulo, textoInterior);
        }
    }
    return { tipo: "Otros Trámites", plazas: null, resumen: titulo };
  }
}

// --- 6. LÓGICA DE BASE DE DATOS ---
async function procesarYGuardarConvocatoria(itemData, textoParaIA, fuente, convocatoriasInsertadasHoy) {
  if (!textoParaIA || textoParaIA.length < 50) return;
  
  const textoLower = textoParaIA.toLowerCase();
  if (textoLower.includes("error 404") || textoLower.includes("página no encontrada") || textoLower.includes("page not found")) {
      console.log(`   ⏭️ Ignorado: La web de destino devolvió un Error 404.`);
      console.log(`   🔗 URL intentada: ${itemData.link}`); // 👈 Pista de rastreo para URLs rotas
      return;
  }

  const analisisIA = await analizarConvocatoriaIA(itemData.title, textoParaIA);
  
  if (analisisIA.tipo === "IGNORAR" || (analisisIA.resumen && analisisIA.resumen.toLowerCase().includes("convenio"))) {
      console.log(`   ⏭️ Ignorado: La IA detectó que es un convenio o trámite no relevante.`);
      return;
  }

  const profesionPrincipal = (analisisIA.profesiones && analisisIA.profesiones.length > 0) ? analisisIA.profesiones[0] : null;
  if (!analisisIA.profesion && !analisisIA.plazas && analisisIA.tipo === "Otros Trámites") return;

  const departamentoFinal = analisisIA.organismo || itemData.department;
  let parentSlug = null;
  const tiposNuevos = ['Oposiciones (Turno Libre)', 'Estabilización y Promoción', 'Bolsas de Empleo Temporal', 'Traslados y Libre Designación'];
  const esTramite = !tiposNuevos.includes(analisisIA.tipo);

  if (departamentoFinal) {
    const { data: posiblesPadres } = await supabase
      .from('convocatorias')
      .select('slug, type, link_boe, profesion, profesiones')
      .ilike('department', `%${departamentoFinal}%`)
      .is('parent_slug', null) 
      .order('created_at', { ascending: false }) 
      .limit(15); 

    if (posiblesPadres && posiblesPadres.length > 0) {
      let plazaExistente = null;
      if (profesionPrincipal) {
        const ignorar = ["de", "la", "el", "en", "para", "del", "las", "los", "jefe/a", "jefe", "jefa", "superior", "técnico", "tecnico"];
        const palabrasClave = profesionPrincipal.toLowerCase().split(' ').filter(w => w.length > 3 && !ignorar.includes(w));
        
        if (palabrasClave.length > 0) {
            plazaExistente = posiblesPadres.find(padre => {
               const profPadre = (padre.profesion || '').toLowerCase();
               const coincidencias = palabrasClave.filter(palabra => profPadre.includes(palabra)).length;
               return (coincidencias / palabrasClave.length) >= 0.6;
            });
        }
      }

      if (plazaExistente) {
        if (esTramite) {
          console.log(`   🔗 Trámite detectado de forma segura. Enlazando al padre: ${plazaExistente.slug}...`);
          parentSlug = plazaExistente.slug;
        } else {
          console.log(`   🔄 ¡Duplicado evitado! Esta plaza ya se rastreó antes: ${plazaExistente.slug}`);
          if (fuente.nombre === "BOE" && !plazaExistente.link_boe) {
              await supabase.from("convocatorias").update({ 
                  link_boe: itemData.link, publication_date: new Date().toISOString().split('T')[0] 
              }).eq('slug', plazaExistente.slug);
          }
          return; 
        }
      }
    }
  }

  if (!parentSlug && analisisIA.referencia_boe_original) {
    const { data: parentMatch } = await supabase.from('convocatorias').select('slug')
      .like('link_boe', `%${analisisIA.referencia_boe_original}%`).single();
    if (parentMatch) {
        parentSlug = parentMatch.slug;
        console.log(`   🔗 Enlazado de forma segura por código BOE al padre: ${parentSlug}`);
    }
  }

  let textoPlazas = analisisIA.plazas ? (analisisIA.plazas === 1 ? '1-plaza-' : `${analisisIA.plazas}-plazas-`) : '';
  let textoParaSlug = profesionPrincipal ? `oposiciones-${textoPlazas}${profesionPrincipal}-${departamentoFinal}` : (analisisIA.resumen || itemData.title);
  let slugBase = slugify(textoParaSlug, { lower: true, strict: true, remove: /[*+~.()'"!:@,]/g });
  if (slugBase.length > 80) slugBase = slugBase.substring(0, 80).replace(/-+$/, '');
  
  let suffix = new Date().getTime().toString().slice(-6); 
  if (itemData.guid) {
      const guidLimpio = itemData.guid.replace(/\W/g, ''); 
      if (guidLimpio.length > 6) suffix = guidLimpio.slice(-6); 
  }
  const slugFinal = `${slugBase}-${suffix}`;

  let webDefinitiva = itemData.link;
  let pdfDefinitivo = analisisIA.enlace_pdf || itemData.pdf_rss || itemData.pdf_extraido;

  if (webDefinitiva.toLowerCase().includes('.pdf') || webDefinitiva.toLowerCase().includes('descargararchivo')) {
      pdfDefinitivo = webDefinitiva;
      webDefinitiva = fuente.url; 
  } 
  if (!pdfDefinitivo) pdfDefinitivo = webDefinitiva;

  const fechaPublicacionHoy = new Date().toISOString().split('T')[0];
  const fechaCierreCalculada = calcularFechaCierre(fechaPublicacionHoy, analisisIA.plazo_numero, analisisIA.plazo_tipo);

  const convocatoria = {
    slug: slugFinal, 
    title: limpiarCodificacion(itemData.title), 
    meta_description: limpiarCodificacion(analisisIA.meta_description || (analisisIA.resumen ? analisisIA.resumen.substring(0, 150) + "..." : "Ver detalles.")),
    section: itemData.section, 
    department: departamentoFinal, 
    boletin: `${fuente.nombre} - ${fuente.ambito}`,
    parent_type: "OPOSICION", 
    type: analisisIA.tipo === "IGNORAR" ? "Otros Trámites" : analisisIA.tipo, 
    plazas: analisisIA.plazas, 
    resumen: limpiarCodificacion(analisisIA.resumen),
    plazo_numero: analisisIA.plazo_numero,
    plazo_tipo: analisisIA.plazo_tipo,
    fecha_cierre: fechaCierreCalculada,
    boletin_origen_nombre: analisisIA.boletin_origen_nombre,
    boletin_origen_fecha: analisisIA.boletin_origen_fecha,
    plazo_texto: (analisisIA.plazo_numero && analisisIA.plazo_tipo) ? `${analisisIA.plazo_numero} días ${analisisIA.plazo_tipo}` : null,
    referencia_bases: (analisisIA.boletin_origen_nombre && analisisIA.boletin_origen_fecha) ? `${analisisIA.boletin_origen_nombre} | ${analisisIA.boletin_origen_fecha}` : null,
    grupo: analisisIA.grupo, 
    sistema: analisisIA.sistema, 
    profesion: profesionPrincipal, 
    profesiones: analisisIA.profesiones,
    provincia: analisisIA.provincia || fuente.ambito, 
    titulacion: analisisIA.titulacion, 
    enlace_inscripcion: analisisIA.enlace_inscripcion, 
    tasa: analisisIA.tasa,
    parent_slug: parentSlug, 
    publication_date: new Date().toISOString().split('T')[0], 
    link_boe: webDefinitiva, 
    guid: pdfDefinitivo,
    raw_text: analisisIA.texto_limpio || textoParaIA,
  };

  const { data, error } = await supabase.from("convocatorias").upsert(convocatoria, { onConflict: "slug" }).select();
  
  if (error) {
    console.error(`❌ Error BD:`, error.message);
  } else {
    await gestionarDepartamento(departamentoFinal);
    console.log(`✅ Guardado -> ${fuente.nombre} | Tipo: ${analisisIA.tipo} | Org: ${departamentoFinal}`);
    if (data && data.length > 0) convocatoriasInsertadasHoy.push(data[0]);
  }
}

// --- 7. SISTEMAS DE ALERTAS ---
async function enviarAlertasPorEmail(nuevasConvocatorias) {
  let contadorEnviados = 0; 
  const convocatoriasReales = nuevasConvocatorias.filter(c => c.type === 'Oposiciones (Turno Libre)' || c.type === 'Estabilización y Promoción' || c.type === 'Bolsas de Empleo Temporal');
  if (convocatoriasReales.length === 0 || !process.env.RESEND_API_KEY) return 0;

  const resend = new Resend(process.env.RESEND_API_KEY);
  
  // CAMBIO CLAVE: Ahora leemos de filtros_radar
  const { data: radares } = await supabase.from('filtros_radar').select('*');
  if (!radares || radares.length === 0) return 0;

  for (const radar of radares) {
    if (!radar.filtro) continue;
    const interesStr = radar.filtro.toLowerCase().trim();
    const provinciasSub = radar.provincias || []; 

    const coincidencias = convocatoriasReales.filter(conv => {
      const enTitulo = conv.title && conv.title.toLowerCase().includes(interesStr);
      const enProfesion = conv.profesion && conv.profesion.toLowerCase().includes(interesStr);
      const encajaInteres = enTitulo || enProfesion;
      let encajaProvincia = true;
      if (provinciasSub.length > 0) encajaProvincia = provinciasSub.includes(conv.provincia);
      return encajaInteres && encajaProvincia;
    });

    if (coincidencias.length > 0) {
      // CAMBIO CLAVE: Obtenemos el email real vinculado a ese radar
      const { data: userData } = await supabase.auth.admin.getUserById(radar.user_id);
      if (!userData || !userData.user || !userData.user.email) continue;
      const userEmail = userData.user.email;

      const htmlLista = coincidencias.map(c => {
        const badgePlazas = c.plazas ? `<span style="background-color: #fff7ed; color: #c2410c; padding: 3px 8px; border-radius: 12px; font-size: 12px; font-weight: bold; margin-left: 8px; vertical-align: middle; border: 1px solid #ffedd5;">${c.plazas} plaza${c.plazas > 1 ? 's' : ''}</span>` : '';
        const fechaCierreLimpia = c.fecha_cierre ? c.fecha_cierre.split('-').reverse().join('/') : null;
        const infoCierre = fechaCierreLimpia ? `<div style="color: #dc2626; font-size: 13px; font-weight: 600; margin-top: 6px;">⏳ Fin de plazo aprox: ${fechaCierreLimpia}</div>` : '';

        return `
        <div style="background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 18px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
          <h3 style="margin: 0 0 10px 0; color: #0f172a; font-size: 16px; font-weight: 700; line-height: 1.4;">
            ${c.profesion || c.title} ${badgePlazas}
          </h3>
          <div style="color: #475569; font-size: 14px; line-height: 1.5; margin-bottom: 16px;">
            <span style="display: block; margin-bottom: 4px;">🏛️ <strong>${c.department || 'Administración'}</strong></span>
            <span style="display: block;">📍 ${c.provincia || 'Estatal'}</span>
            ${infoCierre}
          </div>
          <a href="https://topos.es/convocatorias/${c.slug}" style="display: block; text-align: center; background-color: #ea580c; color: #ffffff; text-decoration: none; padding: 10px 16px; border-radius: 6px; font-size: 14px; font-weight: 600;">Inspeccionar túnel &rarr;</a>
        </div>`
      }).join('');

      try {
        const emailHTML = `
        <div style="background-color: #f8fafc; padding: 30px 10px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
          <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e2e8f0;">
            
            <div style="background-color: #ea580c; padding: 25px; text-align: center;">
              <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">TOPOS.es 🐾</h1>
            </div>
            
            <div style="padding: 30px 25px; background-color: #f8fafc;">
              <h2 style="margin-top: 0; margin-bottom: 15px; color: #1e293b; font-size: 20px;">¡El Topo ha encontrado algo!</h2>
              <p style="color: #475569; font-size: 15px; line-height: 1.6; margin-bottom: 25px; margin-top: 0;">
                Escarbando en los boletines de hoy, hemos desenterrado nuevas plazas que coinciden con tu rastro: <strong style="color: #ea580c; background: #ffedd5; padding: 2px 6px; border-radius: 4px;">${radar.filtro}</strong>
              </p>
              
              ${htmlLista}
              
            </div>
            
            <div style="background-color: #ffffff; padding: 25px; text-align: center; border-top: 1px solid #e2e8f0;">
              <p style="color: #64748b; font-size: 13px; margin: 0 0 10px 0; line-height: 1.5;">
                Recibes este correo porque El Topo está vigilando este rastro para ti. Puedes gestionar tus alertas o decirle que deje de buscar desde tu Madriguera.
              </p>
              <a href="https://topos.es/perfil" style="color: #94a3b8; font-size: 12px; text-decoration: underline;">Ir a mi Madriguera</a>
            </div>
            
          </div>
        </div>
        `;

        await resend.emails.send({
          from: 'TOPOS.es <alertas@topos.es>', 
          to: userEmail,
          subject: `🐾 Nuevas plazas rastreadas: ${radar.filtro}`,
          html: emailHTML
        });
        contadorEnviados++;
        await esperar(1000); 
      } catch (err) {}
    }
  }
  return contadorEnviados;
}

async function enviarAlertasFavoritos(nuevasConvocatorias) {
  let contadorEnviados = 0; 
  const actualizaciones = nuevasConvocatorias.filter(c => c.parent_slug);
  if (actualizaciones.length === 0 || !process.env.RESEND_API_KEY) return 0;

  const resend = new Resend(process.env.RESEND_API_KEY);
  for (const update of actualizaciones) {
    const { data: seguidores } = await supabase.from('favoritos').select('user_id').eq('convocatoria_slug', update.parent_slug);
    if (!seguidores || seguidores.length === 0) continue;

    for (const seguidor of seguidores) {
      const { data: userData } = await supabase.auth.admin.getUserById(seguidor.user_id);
      if (userData && userData.user && userData.user.email) {
        try {
          const emailHTML = `
          <div style="background-color: #f8fafc; padding: 30px 10px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
            <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e2e8f0;">
              <div style="background-color: #10b981; padding: 25px; text-align: center;">
                <span style="font-size: 32px; display: block; margin-bottom: 10px;">🐾</span>
                <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: 800;">Novedades en tu plaza vigilada</h1>
              </div>
              <div style="padding: 30px 25px;">
                <p style="color: #475569; font-size: 16px; line-height: 1.6; margin-top: 0;">El Topo ha detectado un <strong>nuevo trámite oficial</strong> publicado hoy en los boletines para la plaza que tienes guardada en tu Madriguera.</p>
                <div style="background-color: #ecfdf5; border-left: 4px solid #10b981; border-radius: 0 8px 8px 0; padding: 16px; margin: 25px 0;">
                  <strong style="color: #065f46; display: block; margin-bottom: 6px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">Actualización detectada:</strong>
                  <span style="color: #047857; font-size: 15px; line-height: 1.5;">${update.resumen || update.title}</span>
                </div>
                <a href="https://topos.es/convocatorias/${update.slug}" style="display: block; text-align: center; background-color: #10b981; color: #ffffff; text-decoration: none; padding: 12px 20px; border-radius: 6px; font-size: 15px; font-weight: 600;">Ver documento oficial &rarr;</a>
              </div>
              <div style="background-color: #ffffff; padding: 25px; text-align: center; border-top: 1px solid #e2e8f0;">
                <a href="https://topos.es/perfil" style="color: #94a3b8; font-size: 12px; text-decoration: underline;">Gestionar mis plazas desde la Madriguera</a>
              </div>
            </div>
          </div>
          `;

          await resend.emails.send({
            from: 'TOPOS.es <alertas@topos.es>', 
            to: userData.user.email,
            subject: `🐾 Hay novedades en la plaza que vigilas`,
            html: emailHTML
          });
          contadorEnviados++;
          await esperar(1000); 
        } catch (err) {}
      }
    }
  }
  return contadorEnviados;
}

async function enviarAlertaTelegram(nuevasConvocatorias) {
  const convocatoriasReales = nuevasConvocatorias.filter(c => c.type === 'Oposiciones (Turno Libre)' || c.type === 'Estabilización y Promoción' || c.type === 'Bolsas de Empleo Temporal');
  if (convocatoriasReales.length === 0) return;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHANNEL_ID; 
  if (!token || !chatId) return;

  // Temática del Topo 🐾
  let texto = `🐾 *¡El Topo acaba de salir a la superficie!* 🐾\n\nHoy ha desenterrado *${convocatoriasReales.length}* nuevas plazas:\n\n`;
  
  convocatoriasReales.slice(0, 10).forEach(c => {
    const plazas = c.plazas ? `(*${c.plazas} ${c.plazas === 1 ? 'plaza' : 'plazas'}*) ` : '';
    texto += `💼 *${c.profesion || 'Nueva Convocatoria'}* ${plazas}\n🏛️ ${c.department || 'Administración'} ${c.provincia && c.provincia !== 'Estatal' ? `(${c.provincia})` : ''}\n👉 [Inspeccionar túnel](https://topos.es/convocatorias/${c.slug})\n\n`;
  });
  
  if (convocatoriasReales.length > 10) {
    texto += `_Y ${convocatoriasReales.length - 10} convocatorias más en la web._\n\n`;
  }
  
  // Call to Action (Llamada a la acción para captar usuarios)
  texto += `🕳️ *Crea tu propia Madriguera* para que el Topo te avise por email solo de lo que te interesa: [Entrar gratis](https://topos.es)`;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'Markdown', disable_web_page_preview: true })
    });
  } catch (err) {}
}

async function enviarReporteAdmin(insertadas, alertasEmail, alertasFavs, errores, minutos) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID; 
  if (!token || !adminChatId) return;

  // Temática del Topo Jefe 👷‍♂️
  const texto = `🐾 *Reporte del Topo Jefe* 🐾\n\n⛏️ *${insertadas}* Plazas desenterradas.\n📨 *${alertasEmail}* Avisos de rastros enviados.\n🔔 *${alertasFavs}* Alertas de plazas vigiladas.\n⚠️ *${errores}* Túneles cortados (Errores web).\n⏱️ *Tiempo de excavación:* ${minutos} minutos.`;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: adminChatId, text: texto, parse_mode: 'Markdown' })
    });
  } catch (err) {}
}

// --- 8. BUCLE PRINCIPAL ---
async function extraerBoletines() {
  const startTime = Date.now(); 
  let totalErrores = 0; 

  try {
    const convocatoriasInsertadasHoy = [];

    for (const fuente of FUENTES_BOLETINES) {
      if (iaDetenida) break; 
      console.log(`\n==============================================`);
      console.log(`📡 Rastreando ${fuente.nombre} (${fuente.ambito}) - Modo: ${fuente.tipo}`);
      console.log(`==============================================`);
      
      try {
        if (fuente.tipo === "rss") {
          const resRss = await fetch(fuente.url, { headers: { "User-Agent": "Mozilla/5.0" } });
          const buffer = await resRss.arrayBuffer();
          let decoder = new TextDecoder("utf-8"); 
          const preview = new TextDecoder("utf-8").decode(buffer.slice(0, 250));
          if (preview.toLowerCase().includes('iso-8859-1')) decoder = new TextDecoder("iso-8859-1"); 
          const xmlDecodificado = decoder.decode(buffer);
          const feed = await parser.parseString(xmlDecodificado); 

          for (const item of feed.items.reverse()) {
            if (iaDetenida) break; 
            let contenidoItem = item.contentSnippet || item.content || item.description || "";
            const t = (item.title + " " + contenidoItem).toLowerCase();

            if (!t.includes('oposición') && !t.includes('oposicion') && !t.includes('concurso') && 
                !t.includes('provisión') && !t.includes('provision') && !t.includes('empleo') && 
                !t.includes('plaza') && !t.includes('bolsa') && !t.includes('selectiv') && 
                !t.includes('ingreso') && !t.includes('convocatoria') && !t.includes('vacante')) {
                continue;
            }

            let tituloFinal = item.title;
            if (fuente.nombre === "BOCM" && contenidoItem) {
                tituloFinal = contenidoItem.replace(/<[^>]*>?/gm, '').replace(/\n/g, ' ').trim(); 
                if (tituloFinal.length > 200) tituloFinal = tituloFinal.substring(0, 200) + "..."; 
            }

            const categoriaSeccion = item.categories?.[0] || `Boletín ${fuente.nombre}`;
            const categoriaOrganismo = item.categories?.[1] || fuente.ambito;

            console.log(`\n📄 Extrayendo interior de: ${tituloFinal.substring(0,60)}...`);
            let textoParaIA = null;
            let pdfExtraidoNativo = null; 

            if (["BOE", "DOG", "BOCM", "BOJA"].includes(fuente.nombre)) {
              const nativo = await obtenerTextoNativo(item.link);
              textoParaIA = nativo.texto;
              pdfExtraidoNativo = nativo.pdf;
            } else if (item.link.toLowerCase().includes('pdf')) {
              textoParaIA = item.title + " - " + (item.contentSnippet || item.content || "");
            } else {
              textoParaIA = await obtenerTextoUniversal(item.link);
            }
            
            if (!textoParaIA || textoParaIA.length < 50) textoParaIA = item.contentSnippet || item.content;
            if (textoParaIA && textoParaIA.length > 8000) textoParaIA = textoParaIA.substring(0, 8000) + "... [Texto cortado]";
            
            let enlacePdfRss = item.enclosure?.url || null;
            if (!enlacePdfRss && item.guid && item.guid.toLowerCase().includes('.pdf')) enlacePdfRss = item.guid;

            await procesarYGuardarConvocatoria({ 
              title: tituloFinal, link: item.link, guid: item.guid, 
              pdf_rss: enlacePdfRss || pdfExtraidoNativo, section: categoriaSeccion, department: categoriaOrganismo 
            }, textoParaIA, fuente, convocatoriasInsertadasHoy);
            
            await esperar(1500);
          }
        } 
        
        else if (fuente.tipo === "html_directo") {
          const hoy = new Date();
          const yyyy = hoy.getFullYear();
          const mm = String(hoy.getMonth() + 1).padStart(2, '0');
          const dd = String(hoy.getDate()).padStart(2, '0');
          
          // 💡 REEMPLAZADOR UNIVERSAL DE FECHAS
          let urlFinal = fuente.url
            .replace(/{YYYYMMDD}/g, `${yyyy}${mm}${dd}`)
            .replace(/{DD\/MM\/YYYY}/g, `${dd}/${mm}/${yyyy}`)
            .replace(/{YYYY}-{MM}-{DD}/g, `${yyyy}-${mm}-${dd}`)
            .replace(/{YYYY}/g, yyyy)
            .replace(/{MM}/g, mm)
            .replace(/{DD}/g, dd);

          console.log(`🌐 URL objetivo generada: ${urlFinal}`); // 👈 Imprimimos la URL para confirmar que está bien

          // 🛡️ NUEVO: INTERCEPTOR RSS -> HTML (Para el BOIB)
          if (fuente.rssToHtml) {
              console.log(`   🔗 Extrayendo URL real del último boletín desde su RSS puente...`);
              try {
                  const resRss = await fetch(urlFinal);
                  const xmlRss = await resRss.text();
                  const feed = await parser.parseString(xmlRss);
                  if (feed.items && feed.items.length > 0) {
                      urlFinal = feed.items[0].link; // Sobrescribimos con el enlace directo al boletín de hoy
                      console.log(`   ✅ Boletín localizado: ${urlFinal}`);
                  } else {
                      console.log(`   ⏭️ El RSS puente está vacío.`);
                      continue;
                  }
              } catch (e) {
                  console.error(`   ❌ Error leyendo el RSS puente: ${e.message}`);
                  totalErrores++;
                  continue;
              }
          }

          console.log(`🌐 URL objetivo generada: ${urlFinal}`);

          let markdownWeb = null;
          if (fuente.nombre === "BOA") {
              const res = await fetch(urlFinal);
              markdownWeb = await res.text();
          } else {
              markdownWeb = await obtenerTextoUniversal(urlFinal);
          }
          if (!markdownWeb) continue;

          if (markdownWeb.length > 12000) markdownWeb = markdownWeb.substring(0, 12000); 

          console.log(`🤖 Buscando enlaces de empleo en el sumario de ${fuente.nombre}...`);
          const listado = await extraerEnlacesSumarioIA(markdownWeb, fuente.nombre);
          if (listado.length > 0) console.log(`✅ Encontradas ${listado.length} posibles convocatorias.`);

          for (const item of listado) {
            if (iaDetenida) break; 
            const t = item.titulo.toLowerCase();
            if (t.includes('carta de servicios') || t.includes('pago de anuncios') || t.includes('publicar en') || item.titulo.length < 30) continue;

            // 🛡️ EL ESCUDO ANTI-404: Ignorar anclas internas (Arregla Cataluña)
            let enlaceLimpio = item.enlace.replace(/[>)"'\]]/g, '').trim();
            
            if (enlaceLimpio.includes('#section') || enlaceLimpio.includes('sumari-del-dogc') || enlaceLimpio.startsWith('#')) {
                console.log(`   ⏭️ Ignorado: El enlace es un salto interno de la web -> ${enlaceLimpio}`);
                continue;
            }

            let enlaceFinal = enlaceLimpio;
            try {
                if (!enlaceFinal.startsWith('http')) {
                    const urlBaseObj = new URL(fuente.url);
                    if (enlaceFinal.startsWith('/')) {
                        enlaceFinal = urlBaseObj.origin + enlaceFinal;
                    } else {
                        enlaceFinal = new URL(enlaceLimpio, fuente.url).href;
                    }
                }
            } catch (e) {
               console.log(`⚠️ Enlace mal formado ignorado: ${enlaceLimpio}`);
               totalErrores++; 
               continue;
            }
            
            if (!enlaceFinal || enlaceFinal === fuente.url || enlaceFinal === fuente.url + '/') continue;

            await gestionarDepartamento(item.departamento);
            console.log(`\n📄 Extrayendo interior de: ${item.titulo.substring(0,60)}...`);
            
            let textoInterior = null;
            let pdfExtraidoNativo = null; 
            
            if (["BOA", "BOCYL", "DOCM"].includes(fuente.nombre)) {
                 const nativo = await obtenerTextoNativo(enlaceFinal);
                 textoInterior = nativo.texto;
                 pdfExtraidoNativo = nativo.pdf;
            } else {
                 textoInterior = await obtenerTextoUniversal(enlaceFinal);
            }
            if (!textoInterior) continue;

            if (textoInterior.length > 5000) textoInterior = textoInterior.substring(0, 5000) + "... [Texto cortado]";

            await procesarYGuardarConvocatoria({ 
              title: item.titulo, link: enlaceFinal, guid: enlaceFinal, 
              pdf_extraido: pdfExtraidoNativo, section: `Boletín ${fuente.nombre}`, department: item.departamento 
            }, textoInterior, fuente, convocatoriasInsertadasHoy);
            
            await esperar(1500);
          }
        }
      } catch (err) {
        console.error(`❌ Error procesando ${fuente.nombre}:`, err.message);
        totalErrores++;
      }
    }

    console.log(`\n🎉 RASTREO COMPLETADO. Total nuevas insertadas: ${convocatoriasInsertadasHoy.length}`);
    
    let alertasEmail = 0;
    let alertasFavs = 0;

    if (convocatoriasInsertadasHoy.length > 0) {
      //alertasEmail = await enviarAlertasPorEmail(convocatoriasInsertadasHoy) || 0;
      //alertasFavs = await enviarAlertasFavoritos(convocatoriasInsertadasHoy) || 0;
     // await enviarAlertaTelegram(convocatoriasInsertadasHoy);
    }
    if (process.env.VERCEL_WEBHOOK && convocatoriasInsertadasHoy.length > 0) await fetch(process.env.VERCEL_WEBHOOK, { method: 'POST' });

    const durationMinutes = ((Date.now() - startTime) / 60000).toFixed(2);
    //await enviarReporteAdmin(convocatoriasInsertadasHoy.length, alertasEmail, alertasFavs, totalErrores, durationMinutes);

  } catch (error) {
    console.error("🔥 Error crítico general:", error);
  }
}

extraerBoletines();