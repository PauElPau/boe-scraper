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

// 🧠 INICIALIZACIÓN LIMPIA DE OPENAI (gpt-4o-mini)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, 
});

let iaDetenida = false;

const parser = new Parser({
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  },
});

// --- 2. CONFIGURACIÓN DE BOLETINES ---
const FUENTES_BOLETINES = [
  { nombre: "BOE", tipo: "rss", url: "https://www.boe.es/rss/boe.php?s=2B", ambito: "Estatal" },
  { nombre: "BOJA", tipo: "rss", url: "https://www.juntadeandalucia.es/boja/distribucion/s53.xml", ambito: "Andalucía" },
  { nombre: "BOPV", tipo: "rss", url: "https://www.euskadi.eus/bopv2/datos/Ultimo.xml", ambito: "País Vasco" },
  { nombre: "BORM", tipo: "rss", url: "https://www.borm.es/rss/boletin.xml", ambito: "Región de Murcia" },
  { nombre: "DOE", tipo: "rss", url: "https://doe.juntaex.es/rss/rss.php?seccion=6", ambito: "Extremadura" },
  { nombre: "DOG", tipo: "rss", url: "https://www.xunta.gal/diario-oficial-galicia/rss/Sumario_es.rss", ambito: "Galicia" },
  { nombre: "BOCM", tipo: "rss", url: "https://www.bocm.es/ultimo-boletin.xml", ambito: "Madrid" },
  { nombre: "BOA", tipo: "rss", url: "https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI?CMD=RSSLST&DOCS=1-200&BASE=BOLE&SEC=BOARSS&SEPARADOR=&PUBL-C=lafechaxx", ambito: "Aragón" },
  { nombre: "BOC", tipo: "rss", url: "https://www.gobiernodecanarias.org/boc/feeds/capitulo/autoridades_personal_oposiciones.rss", ambito: "Canarias" },  

  { nombre: "DOGV", tipo: "html_directo", url: "https://sede.gva.es/es/novetats-ocupacio-publica?fecha={DD}%2F{MM}%2F{YYYY}", ambito: "Comunidad Valenciana" },
  { nombre: "DOCM", tipo: "html_directo", url: "https://docm.jccm.es/docm/cambiarBoletin.do?fecha={YYYYMMDD}", ambito: "Castilla-La Mancha" },   
  { nombre: "BOCYL", tipo: "html_directo", url: "https://bocyl.jcyl.es/boletin.do?fechaBoletin={DD/MM/YYYY}#I.B._AUTORIDADES_Y_PERSONAL", ambito: "Castilla y León" },
  { nombre: "BOIB", tipo: "html_directo", url: "https://www.caib.es/eboibfront/indexrss.do?lang=es", ambito: "Islas Baleares", rssToHtml: true }, 
  { nombre: "BOPA", tipo: "html_directo", url: "https://sede.asturias.es/ultimos-boletines?p_r_p_summaryLastBopa=true", ambito: "Asturias" },
  { nombre: "BON", tipo: "html_directo", url: "https://bon.navarra.es/es/ultimo", ambito: "Navarra" },

  // 🛑 BOLETINES EN "CUARENTENA" (Requieren Scraping de 2 Fases, RSS privados o bypass avanzado)
  // { nombre: "BOC_CANTABRIA", tipo: "html_directo", url: "https://boc.cantabria.es/boces/boletines.do", ambito: "Cantabria" }
  // { nombre: "BOCCE", tipo: "html_directo", url: "https://www.ceuta.es/ceuta/bocce", ambito: "Ceuta" },
  // { nombre: "BOME", tipo: "html_directo", url: "https://bomemelilla.es/", ambito: "Melilla" },
  // { nombre: "BOR", tipo: "html_directo", url: "https://web.larioja.org/bor-portada", ambito: "La Rioja" },
  // { nombre: "DOGC", tipo: "html_directo", url: "https://dogc.gencat.cat/es/inici/resultats/index.html?orderBy=3&page=1&typeSearch=1&advanced=true&current=true&title=true&numResultsByPage=50&publicationDateInitial={DD/MM/YYYY}&thematicDescriptor=D4090&thematicDescriptor=DE1738", ambito: "Cataluña" }
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

// 🧹 Helper para formatear profesiones a Title Case (Primera Letra Mayúscula)
function capitalizarProfesion(str) {
    if (!str) return str;
    const palabrasMenores = ['y', 'e', 'o', 'u', 'de', 'del', 'al', 'en', 'por', 'para', 'con', 'sin', 'a', 'las', 'los', 'la', 'el', 'un', 'una'];
    return str.toLowerCase().split(/\s+/).map((word, index) => {
        // Mantenemos en minúscula las palabras menores, salvo que sean la primera palabra
        if (index > 0 && palabrasMenores.includes(word)) {
            return word;
        }
        return word.charAt(0).toUpperCase() + word.slice(1);
    }).join(' ');
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

// 🛡️ MEJORA: Escudo Anti-Geobloqueo, Atajo Directo y Preservación de Enlaces
async function obtenerTextoNativo(url, forzarCodeTabs = false) {
  let html = "";
  let exito = false;
  
  // 1. Intento CodeTabs (Si está forzado o como primera opción rápida)
  if (forzarCodeTabs) {
    console.log(`   🚀 Atajo activado: Saltando barreras y yendo directo al Plan D (CodeTabs)...`);
    try {
      const proxyUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`;
      const resProxy = await fetch(proxyUrl);
      if (resProxy.ok) {
          html = await resProxy.text();
          exito = true;
      } else {
          console.log(`   ⚠️ CodeTabs falló (Status ${resProxy.status}). Cayendo a cascada secundaria...`);
      }
    } catch (e) {
      console.log(`   ⚠️ Error de red en CodeTabs. Cayendo a cascada secundaria...`);
    }
  }

  // 2. Cascada Secundaria (Si no era CodeTabs o si CodeTabs falló)
  if (!exito) {
    try {
      const respuesta = await fetch(url, {
          headers: { 
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
              "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "es-ES,es;q=0.9"
          }
      });
      if (!respuesta.ok) throw new Error("Nativo bloqueado");
      html = await respuesta.text();
    } catch (error) {
      console.log(`   ⚠️ Fallo de red detectado (Posible geobloqueo). Activando Proxy Público...`);
      try {
        const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
        const resProxy = await fetch(proxyUrl);
        if (!resProxy.ok) throw new Error("Proxy denegado");
        html = await resProxy.text();
      } catch (e2) {
        // Último intento con CodeTabs (por si no lo habíamos forzado antes)
        if (!forzarCodeTabs) {
            console.log(`   ⚠️ AllOrigins bloqueado. Activando Plan D (Proxy CodeTabs)...`);
            try {
              const proxyUrl2 = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`;
              const resProxy2 = await fetch(proxyUrl2);
              if (!resProxy2.ok) throw new Error("Proxy CodeTabs denegado");
              html = await resProxy2.text();
            } catch (e3) {
              console.error(`   ❌ Imposible acceder a la web con ningún método: ${url}`);
              return { texto: null, pdf: null }; 
            }
        } else {
            console.error(`   ❌ Imposible acceder a la web con ningún método: ${url}`);
            return { texto: null, pdf: null };
        }
      }
    }
  }

  const $ = cheerio.load(html);
  let pdfLink = null;
  
  // 🧠 MAGIA AQUÍ: Convertimos los enlaces <a> en texto Markdown para que la IA los vea
  $('a').each((i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      
      // Guardamos el PDF directo si lo hay (Escudo Anti-PDF)
      if (href.toLowerCase().includes('.pdf') || href.toLowerCase().includes('descargararchivo') || href.toLowerCase().includes('document-del-dogc')) {
          if (!pdfLink) {
              try { pdfLink = new URL(href, url).href; } catch(e){}
          }
      }
      
      // Reescribimos el texto del enlace para que .text() no lo borre
      const textoEnlace = $(el).text().replace(/\s+/g, ' ').trim();
      if (textoEnlace && !href.startsWith('javascript') && !href.startsWith('#')) {
          $(el).text(`[${textoEnlace}](${href})`);
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
         // 🛡️ SALVAVIDAS: Si Cloudflare se rinde, no devolvemos null, intentamos la ruta nativa/proxy
         console.log(`   ❌ Cloudflare agotó los reintentos (429). Activando salvavidas Nativo/Proxy para: ${url}`);
         const nativo = await obtenerTextoNativo(url);
         return nativo.texto;
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

// --- 5. MOTORES DE IA (GPT-4o-mini) ---
async function extraerEnlacesSumarioIA(markdownWeb, nombreBoletin) {
  const prompt = `
    Eres un experto en empleo público. Analiza este sumario/portada del boletín ${nombreBoletin} en Markdown.
    Tu misión es extraer SOLO las resoluciones individuales de convocatorias de empleo (oposiciones, concursos, plazas, bolsas, estabilización, libre designación).
    
    REGLAS ESTRICTAS:
    1. IGNORA menús de navegación, cabeceras, convenios colectivos, acuerdos de empresas y "cartas de servicios".
    2. IGNORA CUALQUIER RESOLUCIÓN CUYA FECHA SEA DE AÑOS ANTERIORES.
    3. Busca bajo CUALQUIER apartado que indique empleo, ya sea autonómico, local o estatal.
    4. Devuelve la URL EXACTA que acompaña a cada resolución específica.
    5. MUY IMPORTANTE: Ignora los enlaces que sean anclas internas de la misma página (que contengan "#" o "sumari"). Busca el enlace real al documento individual o al PDF.
    6. DEDUCCIÓN DEL DEPARTAMENTO: Si la resolución está debajo del nombre de un municipio (ejemplo: debajo de "ELX/ELCHE"), el departamento DEBE SER "Ayuntamiento de [Nombre del Municipio]".
    7. 🚫 REGLA DE EXCLUSIÓN TERRITORIAL: IGNORA por completo cualquier enlace que esté clasificado bajo el encabezado "Otras comunidades autónomas", "Otras administraciones" o equivalentes. Solo queremos extraer lo propio de este boletín, no el eco de otras regiones.
    8. ⚠️ TÍTULO COMPLETO: En el campo "titulo" DEBES copiar TODO el texto de la resolución. ¡PROHIBIDO RESUMIR O RECORTAR CON "..."! Es vital que el título contenga la categoría profesional exacta que suele ir al final.

    Devuelve ÚNICAMENTE un JSON con esta estructura:
    { "convocatorias": [ { "titulo": "...", "enlace": "...", "departamento": "..." } ] }
    Si no hay nada relevante, devuelve { "convocatorias": [] }.
    
    TEXTO:
    ${markdownWeb}
  `;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.0, 
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: "You output strict JSON." }, { role: "user", content: prompt }]
    });
    return JSON.parse(response.choices[0].message.content).convocatorias || [];
  } catch (error) {
    if (error.status === 401) {
      console.error("❌ API Key de OpenAI inválida o sin saldo.");
      iaDetenida = true;
    } else if (error.status === 429) {
      console.warn("⚠️ Rate limit de OpenAI alcanzado. Reintentando en 5 segundos...");
      await esperar(5000);
      return extraerEnlacesSumarioIA(markdownWeb, nombreBoletin);
    }
    return [];
  }
}

async function analizarConvocatoriaIA(titulo, textoInterior, departamento, seccion, ambitoAutonomico) {
  const prompt = `
  Eres un experto en extraer datos del empleo público. Analiza el texto de esta web.
  TÍTULO: ${titulo}
  DEPARTAMENTO/ORGANISMO DE ORIGEN: ${departamento || 'No especificado'}
  SECCIÓN DEL BOLETÍN: ${seccion || 'No especificada'}
  COMUNIDAD/CIUDAD AUTÓNOMA: ${ambitoAutonomico}
  TEXTO WEB: ${textoInterior}
  
  ⚠️ REGLAS CRÍTICAS DE EXTRACCIÓN:
  - plazas: Busca cuántas plazas o vacantes se convocan. Traduce palabras a números (ej: 'una plaza' -> 1). Si habla en singular ("un puesto", "la plaza", "la vacante"), el valor es 1. Si es bolsa, null.
  - resumen: Resumen claro de 1-2 frases.
  - descripcion_extendida: Redacta un párrafo atractivo y humano de unas 4 líneas. Describe en qué consiste la oferta o el puesto y da un breve contexto sobre la entidad, organismo o localidad que lo convoca. Tono profesional, informativo y útil para el opositor.
  - plazo_numero: Extrae SOLO la cantidad numérica del plazo (ej: 20).
  - plazo_tipo: Si el texto dice 'días hábiles', deduce 'hábiles'. NUNCA uses la palabra 'días' a secas.
  - grupo: Deduce a partir de 'Técnica Superior'(A1), 'Administrativa'(C1), 'Auxiliar'(C2), etc.
  - sistema: Deduce si es Oposición, Concurso-oposición o Concurso.
  - profesiones: Nombres limpios de los puestos.
  
  - organismo: 🏢 REGLA UNIVERSAL DE ORGANISMO FINAL: 
      Identifica la entidad LOCAL o FINAL que realmente ofrece el puesto (ej: 'Ayuntamiento de Torrevieja', 'Universidad de León', 'Hospital Clínico'). 
      ¡NUNCA uses el nombre genérico de la Comunidad Autónoma a menos que la plaza sea para sus propios servicios centrales! Si el texto no te da pistas claras, déjalo en null, NO te inventes ministerios ni copies los ejemplos del prompt.
  
  - provincia: 🌍 REGLA UNIVERSAL GEOGRÁFICA: 
      1. ESTÁS EN EL TERRITORIO DE: ${ambitoAutonomico}. Es IMPOSIBLE que la provincia elegida pertenezca a otra región (ej: No elijas Castellón si estás en Castilla y León).
      2. Si has detectado que el organismo es un Ayuntamiento, Cabildo, Universidad o entidad local, DEBES deducir la provincia EXACTA a la que pertenece ese municipio.
      3. 🛑 CUIDADO CON LOS HOMÓNIMOS: Si un pueblo tiene un nombre similar a otro en otra región, utiliza el "DEPARTAMENTO/ORGANISMO DE ORIGEN" para desempatar lógicamente.
      4. 🛡️ REGLA DE SALVAGUARDA UNIPROVINCIAL: Si no consigues averiguar el municipio exacto, pero la comunidad autónoma es uniprovincial (ej: Murcia, Asturias, Cantabria, Navarra, La Rioja, Madrid), el valor de la provincia DEBE SER el de esa región, JAMÁS pongas "Estatal".
      5. ⚠️ ALERTA DE ALUCINACIÓN: PROHIBIDO confundir "Castilla-La Mancha" o "Castilla y León" con la provincia de "Castellón".
      
  - titulacion: Busca la titulación mínima exigida. Sé conciso.
  - enlace_inscripcion: URL exacta para presentar instancia (sede electrónica).
  - tasa: Importe de la tasa (derechos de examen) numérico. Ej: 15.20.
  - boletin_origen_nombre: Si las bases están publicadas en otro boletín, extrae SOLO el acrónimo (ej: 'BOE', 'BOP Córdoba').
  - boletin_origen_fecha: Si menciona la fecha del boletín de origen, formato 'YYYY-MM-DD'.
  - meta_description: Descripción corta (máx 150 caracteres) directa al grano, ideal para SEO.
  - enlace_pdf: URL directa al documento oficial PDF.
  `;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      messages: [
        { role: "system", content: "Extrae los datos estructurados siguiendo estrictamente el esquema y las reglas universales proporcionadas." },
        { role: "user", content: prompt }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "convocatoria_schema",
          strict: true,
          schema: {
            type: "object",
            properties: {
              tipo: { type: "string", enum: ['Oposiciones (Turno Libre)', 'Estabilización y Promoción', 'Bolsas de Empleo Temporal', 'Traslados y Libre Designación', 'Listas de Admitidos/Excluidos', 'Exámenes y Tribunales', 'Aprobados y Adjudicaciones', 'Correcciones y Modificaciones', 'Otros Trámites', 'IGNORAR'] },
              plazas: { type: ["integer", "null"] },
              resumen: { type: "string" },
              descripcion_extendida: { type: "string" },
              plazo_numero: { type: ["integer", "null"] },
              plazo_tipo: { type: ["string", "null"], enum: ['hábiles', 'naturales', 'meses', null] },
              grupo: { type: ["string", "null"], enum: ['A1', 'A2', 'B', 'C1', 'C2', 'E', null] },
              sistema: { type: ["string", "null"], enum: ['Oposición', 'Concurso-oposición', 'Concurso', null] },
              profesiones: { type: "array", items: { type: "string" } },
              provincia: { type: ["string", "null"], enum: ['A Coruña', 'Álava', 'Albacete', 'Alicante', 'Almería', 'Asturias', 'Ávila', 'Badajoz', 'Baleares', 'Barcelona', 'Burgos', 'Cáceres', 'Cádiz', 'Cantabria', 'Castellón', 'Ceuta', 'Ciudad Real', 'Córdoba', 'Cuenca', 'Girona', 'Granada', 'Guadalajara', 'Gipuzkoa', 'Huelva', 'Huesca', 'Jaén', 'La Rioja', 'Las Palmas', 'León', 'Lleida', 'Lugo', 'Madrid', 'Málaga', 'Melilla', 'Murcia', 'Navarra', 'Ourense', 'Palencia', 'Pontevedra', 'Salamanca', 'Segovia', 'Sevilla', 'Soria', 'Tarragona', 'Santa Cruz de Tenerife', 'Teruel', 'Toledo', 'Valencia', 'Valladolid', 'Vizcaya', 'Zamora', 'Zaragoza', 'Estatal', null] },
              titulacion: { type: ["string", "null"] },
              enlace_inscripcion: { type: ["string", "null"] },
              tasa: { type: ["number", "null"] },
              boletin_origen_nombre: { type: ["string", "null"] },
              boletin_origen_fecha: { type: ["string", "null"] },
              referencia_boe_original: { type: ["string", "null"], description: "Debe ser estrictamente un código BOE oficial empezando por BOE-A- (Ej: BOE-A-2023-1234). Si no tiene este formato exacto, devuelve null." },
              organismo: { type: ["string", "null"] },
              meta_description: { type: "string" },
              enlace_pdf: { type: ["string", "null"] }
            },
           required: ["tipo", "plazas", "resumen", "descripcion_extendida", "plazo_numero", "plazo_tipo", "grupo", "sistema", "profesiones", "provincia", "titulacion", "enlace_inscripcion", "tasa", "boletin_origen_nombre", "boletin_origen_fecha", "referencia_boe_original", "organismo", "meta_description", "enlace_pdf"],
            additionalProperties: false
          }
        }
      }
    });
    return JSON.parse(response.choices[0].message.content);
  } catch (error) {
    if (error.status === 429) {
      console.warn(`   ⏳ Límite de IA (429). Esperando 5s para reintentar...`);
      await esperar(5000);
      // 🚀 EL ERROR ESTABA AQUÍ: Se nos olvidó pasarle las variables de vuelta al reintento
      return analizarConvocatoriaIA(titulo, textoInterior, departamento, seccion, ambitoAutonomico);
    }
    console.error("❌ Error en analizarConvocatoriaIA:", error.message);
    return { tipo: "Otros Trámites", plazas: null, resumen: titulo };
  }
}

// 🛡️ ESCUDO PRE-FILTRADO: Detecta basura administrativa por el título
function esTramiteBasura(titulo) {
  if (!titulo) return false;
  const t = titulo.toLowerCase();

  const esCese = t.includes('cese') || t.includes('jubilación') || t.includes('jubilacion') || t.includes('renuncia');
  const accionTribunal = t.includes('nombramiento') || t.includes('designación') || t.includes('composición') || t.includes('modificación');
  const esTribunal = t.includes('tribunal') || t.includes('comisión de selección') || t.includes('comisión de valoración') || t.includes('órgano de selección');
  const esNombramientoTribunal = accionTribunal && esTribunal;
  const esRuido = t.includes('convenio') || t.includes('subvención') || t.includes('subvencion') || t.includes('licitación') || t.includes('adjudicación de contrato') || t.includes('impacto ambiental') || t.includes('ley ') || t.includes('decreto ');

  return esCese || esNombramientoTribunal || esRuido;
}

// 🧠 NEUTRALIZADOR DE PALABRAS (Stemmer para Fuzzy Matching)
function limpiarPalabraParaFuzzy(palabra) {
  // 1. Quitar acentos, puntuación y pasar a minúsculas
  let p = palabra.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[.,]/g, "").toLowerCase();
  
  // 2. Quitar sufijos de género típicos (/a, (a))
  p = p.replace(/\/a$/, '').replace(/\(a\)$/, '');
  
  // 3. Quitar plurales básicos ('s' o 'es') si la palabra es larga
  if (p.length > 4 && p.endsWith('s')) p = p.slice(0, -1);
  if (p.length > 4 && p.endsWith('e')) p = p.slice(0, -1); 
  
  // 4. Normalizar abreviaturas clásicas de la Administración
  if (p === 'adm' || p.startsWith('admin')) return 'admin';
  if (p === 'gen' || p.startsWith('gener')) return 'gener';
  if (p.startsWith('tecnic')) return 'tecnic';
  if (p.startsWith('auxil')) return 'auxil';
  if (p.startsWith('ayud')) return 'ayud';
  
  return p;
}

// --- 6. LÓGICA DE BASE DE DATOS ---
async function procesarYGuardarConvocatoria(itemData, textoParaIA, fuente, convocatoriasInsertadasHoy, statsFuente) {
  if (!textoParaIA || textoParaIA.length < 50) {
      statsFuente.errores++;
      return;
  }

  const textoLower = textoParaIA.toLowerCase();
  if (textoLower.includes("error 404") || textoLower.includes("página no encontrada") || textoLower.includes("page not found")) {
      console.log(`   ⏭️ Ignorado: La web de destino devolvió un Error 404.`);
      statsFuente.descartadas_404++;
      return;
  }

  const analisisIA = await analizarConvocatoriaIA(itemData.title, textoParaIA, itemData.department, itemData.section, fuente.ambito);

  if (analisisIA.tipo === "IGNORAR" || (analisisIA.resumen && analisisIA.resumen.toLowerCase().includes("convenio"))) {
      console.log(`   ⏭️ Ignorado: La IA detectó que es un convenio o trámite no relevante.`);
      statsFuente.descartadas_ia++;
      return;
  }

  // Y la SUSTITUYES por este bloque:
  let profesionPrincipal = (analisisIA.profesiones && analisisIA.profesiones.length > 0) ? analisisIA.profesiones[0] : null;
  
  // 🚀 APLICAMOS EL FORMATO 'TITLE CASE' A LAS PROFESIONES
  profesionPrincipal = capitalizarProfesion(profesionPrincipal);
  if (analisisIA.profesiones) {
      analisisIA.profesiones = analisisIA.profesiones.map(capitalizarProfesion);
  }
  
  if (!profesionPrincipal && !analisisIA.plazas && analisisIA.tipo === "Otros Trámites") {
      console.log(`   ⏭️ Descartado: La IA determinó que es un trámite genérico sin plazas ni profesiones.`);
      statsFuente.descartadas_ia++;
      return;
  }

  const departamentoFinal = analisisIA.organismo || itemData.department;
  let parentSlug = null;
  const tiposNuevos = ['Oposiciones (Turno Libre)', 'Estabilización y Promoción', 'Bolsas de Empleo Temporal', 'Traslados y Libre Designación'];
  const esTramite = !tiposNuevos.includes(analisisIA.tipo);

  // 🥇 PRIORIDAD 1: Cruce seguro por BOE
  if (analisisIA.referencia_boe_original && analisisIA.referencia_boe_original.length > 10) {
    const { data: parentMatch } = await supabase.from('convocatorias').select('slug')
      .like('link_boe', `%${analisisIA.referencia_boe_original}%`).single();
    
    if (parentMatch) {
        parentSlug = parentMatch.slug;
        console.log(`   🔗 Enlazado de forma SEGURA por código BOE al padre: ${parentSlug}`);
    }
  }

  // 🥈 PRIORIDAD 2: Fuzzy Matching
  if (!parentSlug && departamentoFinal && profesionPrincipal) {
    const { data: posiblesPadres } = await supabase
      .from('convocatorias')
      .select('slug, type, link_boe, profesion, profesiones')
      .ilike('department', `%${departamentoFinal}%`)
      .is('parent_slug', null) 
      .order('created_at', { ascending: false }) 
      .limit(20); 

    if (posiblesPadres && posiblesPadres.length > 0) {
      let plazaExistente = null;
      const ignorar = ["de", "la", "el", "en", "para", "del", "las", "los", "jefe", "jefa", "superior", "cuerpo", "escala", "plaza", "plazas", "turno", "libre", "acceso"];
      const palabrasClave = profesionPrincipal.split(' ').map(limpiarPalabraParaFuzzy).filter(w => w.length > 3 && !ignorar.includes(w));
      
      if (palabrasClave.length > 0) {
          plazaExistente = posiblesPadres.find(padre => {
             const profPadreStr = (padre.profesion || '');
             const profPadreLimpia = profPadreStr.split(' ').map(limpiarPalabraParaFuzzy).join(' ');
             let coincidencias = 0;
             for (const palabra of palabrasClave) {
                 if (profPadreLimpia.includes(palabra)) coincidencias++;
             }
             return (coincidencias / palabrasClave.length) >= 0.5;
          });
      }

      if (plazaExistente) {
        if (esTramite) {
          console.log(`   🔗 Trámite detectado por Fuzzy Matching (50%). Enlazando al padre: ${plazaExistente.slug}...`);
          parentSlug = plazaExistente.slug;
          statsFuente.enlazadas++; // Sumamos a estadísticas (se guardará después)
        } else {
          console.log(`   🔄 ¡Duplicado evitado! Esta plaza ya se rastreó antes: ${plazaExistente.slug}`);
          statsFuente.duplicados++; // Sumamos a duplicados y cancelamos
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

  let textoPlazas = analisisIA.plazas ? (analisisIA.plazas === 1 ? '1-plaza-' : `${analisisIA.plazas}-plazas-`) : '';
  let textoParaSlug = profesionPrincipal ? `oposiciones-${textoPlazas}${profesionPrincipal}-${departamentoFinal}` : (analisisIA.resumen || itemData.title);
  let slugBase = slugify(textoParaSlug, { lower: true, strict: true, remove: /[*+~.()'"!:@,]/g });
  if (slugBase.length > 80) slugBase = slugBase.substring(0, 80).replace(/-+$/, '');
  
  let suffix = new Date().getTime().toString().slice(-6); 
  if (itemData.guid) {
      const guidLimpio = itemData.guid.replace(/\W/g, ''); 
      const finalGuid = guidLimpio.slice(-6);
      if ((finalGuid.match(/\d/g) || []).length >= 3) {
          suffix = finalGuid;
      } else {
          suffix = Array.from(guidLimpio).reduce((s, c) => Math.imul(31, s) + c.charCodeAt(0) | 0, 0).toString().replace('-','').slice(0,6).padStart(6, '0');
      }
  }
  const slugFinal = `${slugBase}-${suffix}`;

  // --- 🛠️ ASIGNACIÓN DEFINITIVA DE ENLACES (HTML vs PDF) ---
  let webDefinitiva = itemData.link;
  let pdfDefinitivo = analisisIA.enlace_pdf || itemData.pdf_rss || itemData.pdf_extraido;

  // Interceptor Navarra (BON): Si tenemos el HTML, el PDF es predecible
  if (fuente.nombre === "BON" && webDefinitiva.includes('/texto/')) {
      pdfDefinitivo = webDefinitiva.replace('/texto/', '/pdf/');
  }

  // Interceptor Galicia (DOG): Si el HTML acaba en .html, el PDF acaba en .pdf
  if (fuente.nombre === "DOG" && webDefinitiva.endsWith('.html') && !pdfDefinitivo) {
      pdfDefinitivo = webDefinitiva.replace('.html', '.pdf');
  }

  // Si la web principal es en realidad el PDF directo (DOCM, BOCYL, DOE, BORM...)
  if (webDefinitiva.toLowerCase().includes('.pdf') || webDefinitiva.toLowerCase().includes('descargararchivo')) {
      pdfDefinitivo = webDefinitiva;
      // Para link_boe usamos la portada limpia de hoy (itemData.link_boletin) 
      // Si la portada tiene llaves {YYYY}, preferimos usar el PDF para ambas para no guardar URLs rotas
      if (itemData.link_boletin && !itemData.link_boletin.includes('{')) {
          webDefinitiva = itemData.link_boletin;
      } else {
          webDefinitiva = pdfDefinitivo; 
      }
  } 
  
  if (!pdfDefinitivo) pdfDefinitivo = webDefinitiva;

  const fechaPublicacionHoy = new Date().toISOString().split('T')[0];
  const fechaCierreCalculada = calcularFechaCierre(fechaPublicacionHoy, analisisIA.plazo_numero, analisisIA.plazo_tipo);

  const convocatoria = {
    slug: slugFinal, 
    title: limpiarCodificacion(itemData.title), 
    meta_description: limpiarCodificacion(analisisIA.meta_description || (analisisIA.resumen ? analisisIA.resumen.substring(0, 150) + "..." : "Ver detalles.")),
    descripcion_extendida: limpiarCodificacion(analisisIA.descripcion_extendida),
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
    raw_text: textoParaIA, 
  };

  const { data, error } = await supabase.from("convocatorias").upsert(convocatoria, { onConflict: "slug" }).select();
  
  if (error) {
    console.error(`❌ Error BD:`, error.message);
    statsFuente.errores++;
  } else {
    await gestionarDepartamento(departamentoFinal);
    console.log(`✅ Guardado -> ${fuente.nombre} | Tipo: ${analisisIA.tipo} | Org: ${departamentoFinal} | Slug: ${slugFinal} | 🔗 ${webDefinitiva}`);
    statsFuente.guardadas++; // Sumamos como guardada final
    if (data && data.length > 0) convocatoriasInsertadasHoy.push(data[0]);
  }
}

// --- 7. SISTEMAS DE ALERTAS ---
async function enviarAlertasPorEmail(nuevasConvocatorias) {
  let contadorEnviados = 0; 
  const convocatoriasReales = nuevasConvocatorias.filter(c => c.type === 'Oposiciones (Turno Libre)' || c.type === 'Estabilización y Promoción' || c.type === 'Bolsas de Empleo Temporal');
  if (convocatoriasReales.length === 0 || !process.env.RESEND_API_KEY) return 0;

  const resend = new Resend(process.env.RESEND_API_KEY);
  
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
      } catch (err) { }
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
        } catch (err) { }
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

  let texto = `🐾 *¡El Topo acaba de salir a la superficie!* 🐾\n\nHoy ha desenterrado *${convocatoriasReales.length}* nuevas plazas:\n\n`;
  
  convocatoriasReales.slice(0, 10).forEach(c => {
    const plazas = c.plazas ? `(*${c.plazas} ${c.plazas === 1 ? 'plaza' : 'plazas'}*) ` : '';
    texto += `💼 *${c.profesion || 'Nueva Convocatoria'}* ${plazas}\n🏛️ ${c.department || 'Administración'} ${c.provincia && c.provincia !== 'Estatal' ? `(${c.provincia})` : ''}\n👉 [Inspeccionar túnel](https://topos.es/convocatorias/${c.slug})\n\n`;
  });
  
  if (convocatoriasReales.length > 10) {
    texto += `_Y ${convocatoriasReales.length - 10} convocatorias más en la web._\n\n`;
  }
  
  texto += `🕳️ *Crea tu propia Madriguera* para que el Topo te avise por email solo de lo que te interesa: [Entrar gratis](https://topos.es)`;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'Markdown', disable_web_page_preview: true })
    });
  } catch (err) { }
}

async function enviarReporteAdmin(reporteStats, alertasEmail, alertasFavs, erroresGlobales, minutos) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID; 
  if (!token || !adminChatId) return;

  let texto = `🐾 *Reporte del Topo Jefe* 🐾\n⏱️ *Tiempo de excavación:* ${minutos} min\n\n`;

  let totalGuardadas = 0;

  for (const [boletin, stats] of Object.entries(reporteStats)) {
    // Si no encontró nada y no hubo errores, no lo ponemos para no ensuciar el mensaje
    if (stats.encontradas === 0 && stats.errores === 0) continue;
    
    totalGuardadas += stats.guardadas;

    texto += `📰 *${boletin}* (Encontradas: ${stats.encontradas})\n`;
    texto += `  ✅ Guardadas: ${stats.guardadas}\n`;
    if (stats.enlazadas > 0) texto += `  🔗 (De las cuales ${stats.enlazadas} vinculadas a un padre)\n`;
    if (stats.duplicados > 0) texto += `  🔄 Duplicados evitados: ${stats.duplicados}\n`;
    if (stats.descartadas_ia > 0) texto += `  🗑️ Descartadas (Basura/Genérico): ${stats.descartadas_ia}\n`;
    if (stats.descartadas_404 > 0) texto += `  ⚠️ Enlaces rotos (404): ${stats.descartadas_404}\n`;
    if (stats.errores > 0) texto += `  ❌ Errores: ${stats.errores}\n`;
    texto += `\n`;
  }

  texto += `📊 *RESUMEN GLOBAL*\n`;
  texto += `⛏️ Total nuevas guardadas: ${totalGuardadas}\n`;
  texto += `📨 Avisos de rastros (Email): ${alertasEmail}\n`;
  texto += `🔔 Alertas de vigiladas (Email): ${alertasFavs}\n`;
  texto += `💥 Errores web globales: ${erroresGlobales}\n`;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: adminChatId, text: texto, parse_mode: 'Markdown' })
    });
  } catch (err) { console.error("Error enviando Telegram Admin", err); }
}

// --- 8. BUCLE PRINCIPAL ---
async function extraerBoletines() {
  const startTime = Date.now(); 
  let totalErrores = 0; 
  const reporteStats = {};

  try {
    const convocatoriasInsertadasHoy = [];

    for (const fuente of FUENTES_BOLETINES) {
      if (iaDetenida) break; 

      // 👈 NUEVO: Inicializamos las estadísticas de este boletín
      const statsFuente = { encontradas: 0, guardadas: 0, descartadas_ia: 0, descartadas_404: 0, duplicados: 0, enlazadas: 0, errores: 0 };
      reporteStats[fuente.nombre] = statsFuente;
      
      let urlFinalLog = fuente.url;
      if (fuente.tipo === "html_directo") {
          const hoy = new Date();
          const yyyy = hoy.getFullYear();
          const mm = String(hoy.getMonth() + 1).padStart(2, '0');
          const dd = String(hoy.getDate()).padStart(2, '0');
          urlFinalLog = fuente.url
            .replace(/{YYYYMMDD}/g, `${yyyy}${mm}${dd}`)
            .replace(/{DD\/MM\/YYYY}/g, `${dd}/${mm}/${yyyy}`)
            .replace(/{YYYY}-{MM}-{DD}/g, `${yyyy}-${mm}-${dd}`)
            .replace(/{YYYY}/g, yyyy)
            .replace(/{MM}/g, mm)
            .replace(/{DD}/g, dd);
      }

      console.log(`\n==============================================`);
      console.log(`📡 Rastreando ${fuente.nombre} (${fuente.ambito}) - Modo: ${fuente.tipo}`);
      console.log(`🌐 URL objetivo: ${urlFinalLog}`);
      console.log(`==============================================`);
      
      try {
        if (fuente.tipo === "rss") {
          let resRss;
          let fetchIntentos = 3;
          while (fetchIntentos > 0) {
              try {
                  resRss = await fetch(fuente.url, { headers: { "User-Agent": "Mozilla/5.0" } });
                  if (resRss.ok) break;
                  throw new Error(`Status ${resRss.status}`);
              } catch (e) {
                  fetchIntentos--;
                  if (fetchIntentos === 0) throw new Error(`Fetch RSS falló tras 3 intentos: ${e.message}`);
                  console.log(`   ⚠️ Micro-corte al descargar RSS de ${fuente.nombre}. Reintentando en 3s...`);
                  await esperar(3000);
              }
          }

          const buffer = await resRss.arrayBuffer();
          let decoder = new TextDecoder("utf-8"); 
          const preview = new TextDecoder("utf-8").decode(buffer.slice(0, 250));
          if (preview.toLowerCase().includes('iso-8859-1')) decoder = new TextDecoder("iso-8859-1"); 
          const xmlDecodificado = decoder.decode(buffer);
          const feed = await parser.parseString(xmlDecodificado); 

          const listadoValidoRss = [];
          
          for (const item of feed.items.reverse()) {
            if (item.pubDate || item.isoDate) {
                const itemDate = new Date(item.isoDate || item.pubDate);
                const hoy = new Date();
                // 🛡️ FECHAS INFALIBLES: Usamos formato ISO 'YYYY-MM-DD' estricto en huso horario de Madrid
                const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' });
                if (formatter.format(itemDate) !== formatter.format(hoy)) {
                    continue; 
                }
            }
            
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
                // 🚀 ARREGLADO: Ya no cortamos a 200 caracteres para no borrar la profesión
                tituloFinal = contenidoItem.replace(/<[^>]*>?/gm, '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim(); 
            }

            if (esTramiteBasura(tituloFinal)) {
                console.log(`   🧹 Barrido por el Topo (Regex): ${tituloFinal.substring(0,60)}...\n      🔗 ${item.link}`);
                continue;
            }
            
            item.tituloLimpioParaLog = tituloFinal; 
            listadoValidoRss.push(item);
          }

          console.log(`🤖 Buscando enlaces de empleo en el sumario de ${fuente.nombre}...`);
          console.log(`✅ Encontradas ${listadoValidoRss.length} posibles convocatorias únicas.`);

          statsFuente.encontradas = listadoValidoRss.length; // 👈 NUEVO: Guardamos cuántas encontró

          for (const item of listadoValidoRss) {
            if (iaDetenida) break; 

            const categoriaSeccion = item.categories?.[0] || `Boletín ${fuente.nombre}`;
            const categoriaOrganismo = item.categories?.[1] || fuente.ambito;

            // --- 🛠️ EXTRACCIÓN Y LIMPIEZA DE PDFS PARA RSS ---
            let enlacePdfRss = item.enclosure?.url || null;
            if (!enlacePdfRss && item.guid && item.guid.toLowerCase().includes('.pdf')) enlacePdfRss = item.guid;

            // 1. Canarias (BOC): Reconstrucción desde el GUID
            if (fuente.nombre === "BOC" && item.guid && item.guid.includes("BOC-A-")) {
                const partesGuid = item.guid.split("-"); 
                if (partesGuid.length === 5) {
                    item.link = `https://www.gobiernodecanarias.org/boc/${partesGuid[2]}/${partesGuid[3]}/${partesGuid[4]}.html`;
                    enlacePdfRss = `https://sede.gobiernodecanarias.org/boc/boc-a-${partesGuid[2]}-${partesGuid[3]}-${partesGuid[4]}.pdf`.toLowerCase();
                }
            }

            // 2. Aragón (BOA): El PDF usa el mismo DOCN pero cambiando BRSCGI por VERPDF
            if (fuente.nombre === "BOA" && item.link && item.link.includes('DOCN=')) {
                if (item.link.startsWith('/cgi-bin')) item.link = "https://www.boa.aragon.es" + item.link;
                enlacePdfRss = item.link.replace('CMD=VERDOC', 'CMD=VERPDF');
            }

            // 3. Andalucía (BOJA) y País Vasco (BOPV): Convertir PDF relativo a absoluto
            if (enlacePdfRss && !enlacePdfRss.startsWith('http')) {
                if (fuente.nombre === "BOJA" || fuente.nombre === "BOPV") {
                    const urlBase = item.link.substring(0, item.link.lastIndexOf('/') + 1);
                    enlacePdfRss = urlBase + enlacePdfRss;
                }
            }
            // --------------------------------------------------

            console.log(`\n📄 Extrayendo interior de: ${item.tituloLimpioParaLog.substring(0,70)}...\n   🔗 ${item.link}`);
            
            let textoParaIA = null;
            let pdfExtraidoNativo = null;

            // 🚀 AÑADIDOS TODOS LOS RSS AL CARRIL RÁPIDO NATIVO
            if (["BOE", "BOJA", "BOPV", "BORM", "DOE", "DOG", "BOCM", "BOA", "BOC"].includes(fuente.nombre)) {
              const nativo = await obtenerTextoNativo(item.link);
              textoParaIA = nativo.texto;
              pdfExtraidoNativo = nativo.pdf;
            } else if (item.link.toLowerCase().includes('pdf')) {
              textoParaIA = item.tituloLimpioParaLog + " - " + (item.contentSnippet || item.content || "");
            } else {
              textoParaIA = await obtenerTextoUniversal(item.link);
            }
            
            // 🚀 AMPLIADO PARA GPT-4o-mini: Permitimos textos interiores de hasta 25.000 caracteres
            if (!textoParaIA || textoParaIA.length < 50) textoParaIA = item.contentSnippet || item.content;
            if (textoParaIA && textoParaIA.length > 25000) textoParaIA = textoParaIA.substring(0, 25000) + "... [Texto cortado]";

           // 👈 NUEVO: Añadimos statsFuente y link_boletin como parámetros
            await procesarYGuardarConvocatoria({ 
              title: item.tituloLimpioParaLog, link: item.link, guid: item.guid, link_boletin: urlFinalLog,
              pdf_rss: enlacePdfRss || pdfExtraidoNativo, section: categoriaSeccion, department: categoriaOrganismo 
            }, textoParaIA, fuente, convocatoriasInsertadasHoy, statsFuente);
            
            await esperar(6000);
          }
        } 
        
        else if (fuente.tipo === "html_directo") {
          let urlFinal = urlFinalLog; 

          if (fuente.rssToHtml) {
              console.log(`   🔗 Extrayendo URL real del último boletín desde su RSS puente...`);
              try {
                  const resRss = await fetch(urlFinal);
                  const xmlRss = await resRss.text();
                  const feed = await parser.parseString(xmlRss);
                  if (feed.items && feed.items.length > 0) {
                      urlFinal = feed.items[0].link; 
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

          let markdownWeb = null;
          if (fuente.nombre === "BOA") {
              const res = await fetch(urlFinal);
              markdownWeb = await res.text();
          // 🛑 FÍJATE AQUÍ: Ya NO está "BOC_CANTABRIA" en esta lista
          } else if (["BOPA", "BON", "DOCM", "BOCYL", "BOCCE", "BOME"].includes(fuente.nombre)) {
              const nativo = await obtenerTextoNativo(urlFinal, true);
              markdownWeb = nativo.texto;
          } else {
              // 🧠 DOGV, DOGC, BOR y BOC_CANTABRIA caen aquí por descarte (Cloudflare)
              markdownWeb = await obtenerTextoUniversal(urlFinal);
          }
          if (!markdownWeb) continue;

          // 🚀 AMPLIADO PARA GPT-4o-mini: Permitimos sumaros inmensos (hasta 80.000 caracteres)
          if (markdownWeb.length > 80000) markdownWeb = markdownWeb.substring(0, 80000); 

          console.log(`🤖 Buscando enlaces de empleo en el sumario de ${fuente.nombre}...`);
          const listadoBruto = await extraerEnlacesSumarioIA(markdownWeb, fuente.nombre);
          
          const listado = listadoBruto.filter((item, index, self) =>
              index === self.findIndex((t) => t.enlace === item.enlace)
          );

          // 🪵 LOG RESTAURADO: Mostrar siempre el conteo
          console.log(`✅ Encontradas ${listado.length} posibles convocatorias únicas.`);
          statsFuente.encontradas = listado.length; // 👈 NUEVO: Guardamos cuántas encontró

          for (const item of listado) {
            if (iaDetenida) break; 
            const t = item.titulo.toLowerCase();
            
            if (t.includes('carta de servicios') || t.includes('pago de anuncios') || t.includes('publicar en') || esTramiteBasura(item.titulo)) {
                console.log(`   🧹 Barrido por el Topo (Regex): ${item.titulo.substring(0,60)}...\n      🔗 ${item.enlace}`);
                continue;
            }

            let enlaceLimpio = item.enlace.replace(/[>)"'\]]/g, '').trim();

            // 🛠️ INTERCEPTOR DOGV: Reconstruimos la URL perfecta extrayendo solo el ID
            if (fuente.nombre === "DOGV" && (enlaceLimpio.includes('id_emp') || enlaceLimpio.includes('id%5Femp'))) {
                const matchId = enlaceLimpio.match(/id(?:_|%5F)emp=(\d+)/i);
                if (matchId && matchId[1]) {
                    enlaceLimpio = `https://sede.gva.es/detall-ocupacio-publica?id_emp=${matchId[1]}`;
                }
            }

            // 🛠️ INTERCEPTOR BOPA (ASTURIAS): Destripamos la URL fea y construimos el enlace directo al PDF
            if (fuente.nombre === "BOPA" && enlaceLimpio.includes('dispositionText') && enlaceLimpio.includes('dispositionDate')) {
                const matchId = enlaceLimpio.match(/dispositionText=([^&]+)/);
                const matchDate = enlaceLimpio.match(/dispositionDate=([^&]+)/);
                if (matchId && matchDate) {
                    const idDoc = matchId[1];
                    const decodedDate = decodeURIComponent(matchDate[1]); // Convierte 27%2F03%2F2026 a 27/03/2026
                    const partesFecha = decodedDate.split('/'); // [DD, MM, YYYY]
                    if (partesFecha.length === 3) {
                        enlaceLimpio = `https://sede.asturias.es/bopa/${partesFecha[2]}/${partesFecha[1]}/${partesFecha[0]}/${idDoc}.pdf`;
                    }
                }
            }
            
            if (enlaceLimpio.includes('#section') || enlaceLimpio.includes('sumari-del-dogc') || enlaceLimpio.startsWith('#')) {
                console.log(`   ⏭️ Ignorado: El enlace es un salto interno de la web -> ${enlaceLimpio}`);
                continue;
            }

            let enlaceFinal = enlaceLimpio;
            try {
                if (!enlaceFinal.startsWith('http')) {
                    // Usamos urlFinal (sin llaves {}) para que no falle el parseo
                    const urlBaseObj = new URL(urlFinal); 
                    if (enlaceFinal.startsWith('/')) {
                        enlaceFinal = urlBaseObj.origin + enlaceFinal;
                    } else {
                        // Forzamos a que cuelgue del dominio principal para evitar URLs Frankenstein
                        enlaceFinal = urlBaseObj.origin + '/' + enlaceLimpio;
                    }
                }
            } catch (e) {
               console.log(`   ⚠️ Enlace mal formado ignorado: ${enlaceLimpio}`);
               totalErrores++; 
               continue;
            }
            
            if (!enlaceFinal || enlaceFinal === fuente.url || enlaceFinal === fuente.url + '/') continue;

            await gestionarDepartamento(item.departamento);
            
            console.log(`\n📄 Extrayendo interior de: ${item.titulo.substring(0,70)}...\n   🔗 ${enlaceFinal}`);
            
            let textoInterior = null;
            let pdfExtraidoNativo = null; 
            
            if (enlaceFinal.toLowerCase().includes('.pdf')) {
                console.log(`   📄 Enlace PDF directo detectado. Omitiendo descarga HTML...`);
                textoInterior = `${item.titulo}\n\n[Documento oficial publicado directamente en formato PDF. Accede al enlace para leer las bases completas.]`;
                pdfExtraidoNativo = enlaceFinal;
            } else if (["BOPA", "BON"].includes(fuente.nombre)) {
                 const nativo = await obtenerTextoNativo(enlaceFinal, true); // CodeTabs
                 textoInterior = nativo.texto;
                 pdfExtraidoNativo = nativo.pdf;
            } else if (["BOA", "BOCYL", "DOCM", "DOGV"].includes(fuente.nombre)) {
                 const nativo = await obtenerTextoNativo(enlaceFinal);
                 textoInterior = nativo.texto;
                 pdfExtraidoNativo = nativo.pdf;
            } else {
                 textoInterior = await obtenerTextoUniversal(enlaceFinal);
            }

            if (!textoInterior) continue;
            
            // 🚀 AMPLIADO PARA GPT-4o-mini: Hasta 25.000 caracteres de bases
            if (textoInterior.length > 25000) textoInterior = textoInterior.substring(0, 25000) + "... [Texto cortado]";

            await procesarYGuardarConvocatoria({ 
              title: item.titulo, link: enlaceFinal, guid: enlaceFinal, link_boletin: urlFinal,
              pdf_extraido: pdfExtraidoNativo, section: `Boletín ${fuente.nombre}`, department: item.departamento 
            }, textoInterior, fuente, convocatoriasInsertadasHoy, statsFuente);
            
            await esperar(6000);
          }
        }
      } catch (err) {
        console.error(`❌ Error procesando ${fuente.nombre}:`, err.message);
        statsFuente.errores++; // 👈 NUEVO
        totalErrores++;
      }
    }

    console.log(`\n🎉 RASTREO COMPLETADO. Total nuevas insertadas: ${convocatoriasInsertadasHoy.length}`);
    
    let alertasEmail = 0;
    let alertasFavs = 0;

    if (convocatoriasInsertadasHoy.length > 0) {
      //  alertasEmail = await enviarAlertasPorEmail(convocatoriasInsertadasHoy) || 0;
      //  alertasFavs = await enviarAlertasFavoritos(convocatoriasInsertadasHoy) || 0;
      //  await enviarAlertaTelegram(convocatoriasInsertadasHoy);
    }
    if (process.env.VERCEL_WEBHOOK && convocatoriasInsertadasHoy.length > 0) await fetch(process.env.VERCEL_WEBHOOK, { method: 'POST' });

    const durationMinutes = ((Date.now() - startTime) / 60000).toFixed(2);
    // 👈 NUEVO: Pasamos el objeto detallado a Telegram en vez del número simple
    //await enviarReporteAdmin(reporteStats, alertasEmail, alertasFavs, totalErrores, durationMinutes);

  } catch (error) {
    console.error("🔥 Error crítico general:", error);
  }
}

extraerBoletines();