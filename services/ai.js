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
  - descripcion_extendida: 🚀 REGLA SEO CRÍTICA: Escribe un artículo completo de AL MENOS 300 PALABRAS estructurado en formato Markdown. 
    ESTRUCTURA OBLIGATORIA DEL TEXTO EN MARKDOWN:
    1. Introducción atractiva (Usa un H2 ##): Habla sobre la oportunidad de conseguir este puesto en [Organismo] y [Provincia].
    2. Requisitos y Titulación (Usa H3 ### y viñetas -): Explica quién puede presentarse de forma coloquial.
    3. Proceso Selectivo (Usa H3 ###): Resume si es concurso, oposición, qué fases tiene o cómo se va a evaluar.
    4. Plazos y Presentación (Usa H3 ###): Explica cómo y dónde presentar la instancia.
    El texto debe sonar natural, humano, animando al opositor y repitiendo palabras clave orgánicas como "oposiciones", "empleo público", "trabajar en", el nombre de la profesión y la provincia. ¡NO te quedes corto, debes superar las 300 palabras para evitar el 'Thin Content' en Google!
    
  - plazo_numero: Extrae SOLO la cantidad numérica del plazo (ej: 20).
  - plazo_tipo: Si el texto dice 'días hábiles', deduce 'hábiles'. NUNCA uses la palabra 'días' a secas.
  - grupo: Deduce a partir de 'Técnica Superior'(A1), 'Administrativa'(C1), 'Auxiliar'(C2), etc.
  - sistema: Deduce si es Oposición, Concurso-oposición o Concurso.
  - profesiones: Nombres limpios de los puestos.
  
  - categoria: 🗂️ REGLA DE CATEGORIZACIÓN (MACRO-TAXONOMÍA):
      Debes clasificar la profesión principal obligatoriamente en UNA de estas categorías cerradas:
      1. "Administración General" (Ej: Auxiliar administrativo, Técnico de gestión, Administrativo).
      2. "Economía, Hacienda y Finanzas" (Ej: Interventor, Tesorero, Inspector de Hacienda, Recaudación, Economista).
      3. "Sanidad y Salud" (Ej: Enfermería, Medicina, Celador sanitario, Fisioterapia, Veterinaria).
      4. "Cuerpos de Seguridad y Emergencias" (Ej: Policía Local, Bomberos, Guardia Civil, Protección Civil, Ejército).
      5. "Educación y Docencia" (Ej: Maestros, Profesores, Catedráticos, Educador Infantil).
      6. "Informática y Telecomunicaciones" (Ej: Técnico de sistemas, Programador, Ingeniero Informático).
      7. "Ingeniería, Arquitectura y Medio Ambiente" (Ej: Arquitecto, Agente Forestal, Ingeniero de Caminos, Biólogo).
      8. "Justicia y Legislación" (Ej: Juez, Letrado, Auxilio Judicial, Fiscal).
      9. "Trabajo Social y Cuidados" (Ej: Trabajador social, Auxiliar de ayuda a domicilio, Integrador social).
      10. "Cultura, Archivos y Deportes" (Ej: Bibliotecario, Archivero, Técnico de Deportes, Animador, Conservador de museos).
      11. "Oficios y Mantenimiento" (Ej: Peón, Conserje, Limpieza, Conductor, Electricista, Oficial de oficios).
      12. "Otros" (Solo si es absolutamente imposible encajarlo en las 11 anteriores).

  - organismo: 🏢 REGLA UNIVERSAL DE ORGANISMO FINAL: 
      Identifica la entidad LOCAL o FINAL que realmente ofrece el puesto (ej: 'Ayuntamiento de Torrevieja', 'Universidad de León', 'Hospital Clínico'). 
      ¡NUNCA uses el nombre genérico de la Comunidad Autónoma a menos que la plaza sea para sus propios servicios centrales! Si el texto no te da pistas claras, déjalo en null, NO te inventes ministerios ni copies los ejemplos del prompt.
  
  - provincia: 🌍 REGLA UNIVERSAL GEOGRÁFICA: 
      1. ESTÁS EN EL TERRITORIO DE: ${ambitoAutonomico}. Es IMPOSIBLE que la provincia elegida pertenezca a otra región (ej: No elijas Castellón si estás en Castilla y León).
      2. Si has detectado que el organismo es un Ayuntamiento, Cabildo, Universidad o entidad local, DEBES deducir la provincia EXACTA a la que pertenece ese municipio.
      3. 🛑 CUIDADO CON LOS HOMÓNIMOS: Si un pueblo tiene un nombre similar a otro en otra región, utiliza el "DEPARTAMENTO/ORGANISMO DE ORIGEN" para desempatar lógicamente.
      4. 🛡️ REGLA DE SALVAGUARDA UNIPROVINCIAL: Si no consigues averiguar el municipio exacto, pero la comunidad autónoma es uniprovincial (ej: Murcia, Asturias, Cantabria, Navarra, La Rioja, Madrid), el valor de la provincia DEBE SER el de esa región, JAMÁS pongas "Estatal".
      5. ⚠️ MAPA DE CASTILLAS (ANTI-ALUCINACIÓN): NUNCA elijas "Castellón" si la plaza es de Castilla-La Mancha o Castilla y León. 
         - Si es Castilla-La Mancha, deduce la provincia real: Albacete, Ciudad Real, Cuenca, Guadalajara o Toledo. (Si la plaza es general para la Junta y no especifica ciudad, pon Toledo).
         - Si es Castilla y León, deduce la provincia real: Ávila, Burgos, León, Palencia, Salamanca, Segovia, Soria, Valladolid o Zamora. (Si la plaza es general para la Junta y no especifica ciudad, pon Valladolid).
      
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
              categoria: { 
                type: ["string", "null"], 
                enum: [
                  'Administración General', 
                  'Economía, Hacienda y Finanzas', 
                  'Sanidad y Salud', 
                  'Cuerpos de Seguridad y Emergencias', 
                  'Educación y Docencia', 
                  'Informática y Telecomunicaciones', 
                  'Ingeniería, Arquitectura y Medio Ambiente', 
                  'Justicia y Legislación', 
                  'Trabajo Social y Cuidados', 
                  'Cultura, Archivos y Deportes', 
                  'Oficios y Mantenimiento', 
                  'Otros', 
                  null
                ] 
              },
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
           required: ["tipo", "plazas", "resumen", "descripcion_extendida", "plazo_numero", "plazo_tipo", "grupo", "sistema", "profesiones", "categoria", "provincia", "titulacion", "enlace_inscripcion", "tasa", "boletin_origen_nombre", "boletin_origen_fecha", "referencia_boe_original", "organismo", "meta_description", "enlace_pdf"],
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
