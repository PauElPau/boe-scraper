const { OpenAI } = require("openai");
const { esperar } = require("../utils/helpers");

// 🧠 INICIALIZACIÓN LIMPIA DE OPENAI (gpt-4o-mini)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, 
});

let iaDetenida = false;

function setIaDetenida(status) {
  iaDetenida = status;
}

function getIaDetenida() {
  return iaDetenida;
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
      setIaDetenida(true);
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
      6. ⚠️ ALERTA DE ALUCINACIÓN (CASTELLÓN): PROHIBIDO usar la provincia "Castellón" a menos que la comunidad autónoma sea explícitamente "Comunidad Valenciana". Si la comunidad es "Castilla-La Mancha" o "Castilla y León" y la plaza es regional, la provincia DEBE SER el de esa región.
      
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
      return analizarConvocatoriaIA(titulo, textoInterior, departamento, seccion, ambitoAutonomico);
    }
    console.error("❌ Error en analizarConvocatoriaIA:", error.message);
    return { tipo: "Otros Trámites", plazas: null, resumen: titulo };
  }
}

module.exports = {
  extraerEnlacesSumarioIA,
  analizarConvocatoriaIA,
  getIaDetenida,
  setIaDetenida
};
