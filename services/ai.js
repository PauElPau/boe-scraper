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
async function extraerEnlacesSumarioIA(markdownWeb, nombreBoletin, intentos = 3) {
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
      if (intentos > 0) {
          console.warn(`⚠️ Rate limit de OpenAI. Reintentando en 5s... (Quedan ${intentos} intentos)`);
          await esperar(5000);
          return extraerEnlacesSumarioIA(markdownWeb, nombreBoletin, intentos - 1);
      } else {
          console.error("❌ OpenAI no responde tras varios intentos. Saltando...");
          return [];
      }
    }
    return [];
  }
}

async function analizarConvocatoriaIA(titulo, textoInterior, departamento, seccion, ambitoAutonomico, intentos = 3) {
  const prompt = `
  Eres un experto en extraer datos del empleo público. Analiza el texto de esta web.
  TÍTULO: ${titulo}
  DEPARTAMENTO/ORGANISMO DE ORIGEN: ${departamento || 'No especificado'}
  SECCIÓN DEL BOLETÍN: ${seccion || 'No especificada'}
  COMUNIDAD/CIUDAD AUTÓNOMA: ${ambitoAutonomico}
  TEXTO WEB: ${textoInterior}

  🌍 REGLA DE IDIOMA OBLIGATORIA: ¡TODO el contenido que extraigas y redactes DEBE estar traducido al ESPAÑOL (Castellano)! Si el texto original está en catalán, valenciano, gallego o euskera, tradúcelo antes de devolver el JSON.
  
  ⚠️ REGLAS CRÍTICAS DE EXTRACCIÓN (MATRIZ 3D):

  1. EL TIPO (Naturaleza del Puesto):
     - 'Plazas de Nuevo Ingreso': Oposiciones normales para conseguir plaza fija (Turno Libre o Discapacidad).
     - 'Bolsas de Empleo Temporal': Para entrar como interino/sustituto.
     - 'Procesos de Estabilización': Procesos excepcionales para hacer fijos a los interinos.
     - 'Provisión de Puestos y Movilidad': Traslados, libre designación o comisiones de servicio para mover a funcionarios de carrera.
     - 'Ofertas de Empleo Público (OEP)': SOLO el Decreto/Acuerdo que aprueba el listado masivo anual de plazas futuras (sin plazo). 🛑 REGLA VITAL ANTI-CONFUSIÓN: Si el documento es una lista de admitidos, una convocatoria o un examen que simplemente menciona "(Oferta de Empleo Público 202X)" como referencia de origen en su título, el tipo NO es OEP, debe ser 'Plazas de Nuevo Ingreso'.

  2. EL SISTEMA (Cómo se evalúa):
     - 'Oposición': Solo exámenes.
     - 'Concurso de Méritos': Solo se valoran méritos y experiencia (muy común en estabilización y bolsas).
     - 'Concurso-Oposición': Exámenes + méritos.
     - 'Libre Designación': Elección directa por idoneidad (muy común en altos cargos y jefaturas).

 3. LA FASE (Momento temporal del documento):
     - 'Apertura de Plazos / Convocatoria': Cuando se abren las instancias y empieza la cuenta atrás legal para apuntarse. 🛑 REGLA VITAL: Las 'Ofertas de Empleo Público (OEP)' DEBEN clasificarse OBLIGATORIAMENTE en esta fase. 🛑 REGLA ANTI-BLOQUEOS: Si el título dice "aprobación de bases" o "convocatoria", asume que es apertura. ¡PERO OJO!: Si el título también contiene palabras como "nombramiento", "adjudicación", "resuelve el proceso", "lista definitiva" o "toma de posesión", ESTAS PALABRAS TIENEN PRIORIDAD ABSOLUTA y la fase NO será apertura, sino 'Adjudicación y Nombramientos'.
     - 'Listas de Admitidos y Excluidos': Listados provisionales o definitivos de participantes.
     - 'Tribunales y Fechas de Examen': Nombramiento del jurado, sedes, aulas y días de prueba.
     - 'Calificaciones y Resultados': Publicación de las notas del examen o de los puntos de méritos.
     - 'Adjudicación y Nombramientos': El final del proceso (aprobados que consiguen la plaza, tomas de posesión, resolución del concurso, propuesta de nombramiento, o cuando declara el proceso DESIERTO). 🛑 TRAMPA DE DESTINOS: Si el texto indica que se "ofrecen plazas a los aspirantes que han superado el proceso selectivo" o pide presentar solicitud para la "adjudicación de destinos", la fase ES SIEMPRE 'Adjudicación y Nombramientos' y sus plazos deben ser nulos (es un trámite interno para aprobados, no una oposición nueva).
     - 'Correcciones y Modificaciones': Fe de erratas o rectificaciones de bases anteriores.
     - 'Otros Trámites': Renuncias, ceses, aplazamientos o cosas que no encajan arriba.

  -- PLAZOS:
     Extrae el plazo_numero y plazo_tipo SOLO si la FASE es 'Apertura de Plazos / Convocatoria' para presentar solicitudes. 
     🛑 REGLA VITAL: Si la fase es otra (ej: plazo para adjudicar destinos, plazo para recurrir una lista, subsanar un error, etc.), devuelve null en los plazos. NUNCA uses la palabra 'días' a secas en el tipo, deduce 'hábiles' o 'naturales'.

  -- PLAZAS Y TURNOS (DESGLOSE):
     - plazas: Busca el TOTAL de vacantes numérico. Traduce palabras a números. 🛑 REGLA VITAL: Si el TIPO es 'Bolsas de Empleo Temporal', debe ser null.
     - turno: Una convocatoria puede tener varios turnos simultáneos. Deduce los que apliquen y devuélvelos en una lista. Valores: "Turno Libre", "Promoción Interna", "Discapacidad". Si no especifica, asume ["Turno Libre"].
     - distribucion_plazas: Si el texto desglosa plazas por turno, devuelve una lista SUMADA Y AGRUPADA por cada turno. ¡PROHIBIDO REPETIR TURNOS! Debes sumar todas las plazas del mismo turno. Ejemplo: [{"turno": "Turno Libre", "plazas": 40}, {"turno": "Discapacidad", "plazas": 10}]. Si no especifica el reparto, devuelve null.

  -- ÁMBITO:
     Define el alcance territorial del organismo que convoca:
     - 'Estatal': Ministerios, Ejército, Policía Nacional, Guardia Civil o entes puramente estatales.
     - 'Autonómico': Consejerías, Juntas, Generalitat o entes que operan a nivel de toda la comunidad autónoma.
     - 'Local': Ayuntamientos, Diputaciones, Cabildos o Comarcas.
     - 'Universidades': Cualquier universidad pública.

  -- CATEGORÍA, TITULACIÓN, PROFESIÓN, GRUPO, ORGANISMO Y PROVINCIA:
     - titulacion: Busca la titulación mínima exigida. Sé EXTREMADAMENTE CONCISO, máximo 3 o 4 palabras (Ej: 'Bachiller o FP', 'Grado Universitario', 'ESO').
     - categoria: Clasifica obligatoriamente la profesión en UNA de estas: 'Administración General', 'Economía, Hacienda y Finanzas', 'Sanidad y Salud', 'Cuerpos de Seguridad y Emergencias', 'Educación y Docencia', 'Informática y Telecomunicaciones', 'Ingeniería, Arquitectura y Medio Ambiente', 'Justicia y Legislación', 'Trabajo Social y Cuidados', 'Cultura, Archivos y Deportes', 'Oficios y Mantenimiento', 'Otros'. 🛑 REGLA VITAL: Si es una Oferta de Empleo Público (OEP) general sin una profesión clara, asígnale SIEMPRE 'Administración General'.
     - profesiones: Nombres limpios de los puestos.
     - grupo: Deduce a partir de 'Técnica Superior'(A1), 'Administrativa'(C1), 'Auxiliar'(C2), etc.
     - organismo: Identifica la entidad LOCAL o FINAL que ofrece el puesto (ej: 'Ayuntamiento de Torrevieja'). No uses comillas en los nombres.
     - provincia: ESTÁS EN EL TERRITORIO DE: ${ambitoAutonomico}. Es IMPOSIBLE que la provincia elegida pertenezca a otra región. Deduce la provincia exacta del organismo final.
  
  -- TEXTOS SEO Y LINKS:
  - resumen: Resumen claro de 1-2 frases.
  - plazo_numero: Extrae SOLO la cantidad numérica del plazo (ej: 20).
  - plazo_tipo: Si el texto dice 'días hábiles', deduce 'hábiles'. NUNCA uses la palabra 'días' a secas.
  - plazo_numero / plazo_tipo: Extrae el plazo SOLO si es para presentar INSTANCIAS o SOLICITUDES de participación (para apuntarse a la oposición).
    🛑 REGLA VITAL DE PLAZOS: Si el plazo que menciona el texto es para "interponer recurso" (reposición/alzada), para "subsanar errores" o para "presentar méritos", DEBES devolver null en ambos campos. ¡No confundas el plazo legal de recurso de una lista con el plazo de inscripción!
  - grupo: Deduce a partir de 'Técnica Superior'(A1), 'Administrativa'(C1), 'Auxiliar'(C2), etc.
  - sistema: Deduce si es Oposición, Concurso-oposición o Concurso. Si es una OEP o no se especifica claramente en el texto, asume SIEMPRE 'Oposición'.
  - profesiones: Nombres limpios de los puestos.
  - fecha_cierre_exacta: Si el texto indica explícitamente el día exacto en que termina el plazo (ej: 'del 15 al 16 de abril de 2026', 'hasta el 20/05/2026'), deduce la fecha final y devuélvela estrictamente en formato 'YYYY-MM-DD'. Si el texto solo dice '20 días' pero no da el día exacto del calendario, devuelve null.

  - tipo: Deduce el tipo EXACTO de la publicación usando estrictamente el esquema proporcionado. 
    🛑 REGLAS VITALES DE TIPO: 
    1. FINALIZADOS: Si el texto contiene "adjudicación de destin", "nombramiento", "lista definitiva de aprobados", "toma de posesión", "resolución del concurso", "declara desierto" o "constitución de bolsa", usa OBLIGATORIAMENTE 'Adjudicación y Nombramientos'. ¡No es una apertura y NUNCA debes usar 'IGNORAR'!
    2. ESTABILIZACIÓN: Si el texto dice explícitamente "estabilización" o "concurso excepcional", usa 'Estabilización y Promoción'.
    3. CORRECCIONES: Si menciona "corrección de errores" o "modificación de la resolución", usa 'Correcciones y Modificaciones'.

  - titulacion: Busca la titulación mínima exigida. Sé EXTREMADAMENTE CONCISO, máximo 3 o 4 palabras (Ej: 'Bachillerato', 'Grado Universitario', 'ESO', 'Licenciatura en Derecho'). Tradúcelo al español.
  
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

  - turno: Deduce el turno de acceso de la convocatoria. Usa ESTRICTAMENTE uno de estos tres valores:
      1. "Turno Libre" (Si es acceso libre, general, u oposición normal abierta a todos).
      2. "Promoción Interna" (Si menciona que es solo para personal que ya es funcionario o promoción cruzada).
      3. "Discapacidad" (Si es un turno de reserva exclusiva para diversidad funcional/discapacidad).
      *Si no lo especifica o no está claro, asume "Turno Libre".

  - organismo: 🏢 REGLA UNIVERSAL DE ORGANISMO FINAL: 
      Identifica la entidad LOCAL o FINAL que realmente ofrece el puesto (ej: 'Ayuntamiento de Torrevieja', 'Universidad de León', 'Hospital Clínico'). 
      ¡NUNCA uses el nombre genérico de la Comunidad Autónoma a menos que la plaza sea para sus propios servicios centrales! Si el texto no te da pistas claras, déjalo en null, NO te inventes ministerios ni copies los ejemplos del prompt.
      🛑 REGLA ESTRICTA DE NORMALIZACIÓN: No uses NUNCA comillas (ni simples ni dobles) en los nombres (ej. pon Hospital La Paz, no "La Paz", ni 'La Paz'). Si es una Universidad, usa siempre su nombre oficial de forma homogénea (ej. Universitat Jaume I).
  
  - provincia: 🌍 REGLA UNIVERSAL GEOGRÁFICA: 
      1. ESTÁS EN EL TERRITORIO DE: ${ambitoAutonomico}. Es IMPOSIBLE que la provincia elegida pertenezca a otra región (ej: No elijas Castellón si estás en Castilla y León).
      2. Si has detectado que el organismo es un Ayuntamiento, Cabildo, Universidad o entidad local, DEBES deducir la provincia EXACTA a la que pertenece ese municipio.
      3. 🛑 CUIDADO CON LOS HOMÓNIMOS: Si un pueblo tiene un nombre similar a otro en otra región, utiliza el "DEPARTAMENTO/ORGANISMO DE ORIGEN" para desempatar lógicamente.
      4. 🛡️ REGLA DE SALVAGUARDA UNIPROVINCIAL: Si no consigues averiguar el municipio exacto, pero la comunidad autónoma es uniprovincial (ej: Murcia, Asturias, Cantabria, Navarra, La Rioja, Madrid), el valor de la provincia DEBE SER el de esa región, JAMÁS pongas "Estatal".
      5. ⚠️ MAPA DE CASTILLAS (ANTI-ALUCINACIÓN): NUNCA elijas "Castellón" si la plaza es de Castilla-La Mancha o Castilla y León. 
         - Si es Castilla-La Mancha, deduce la provincia real: Albacete, Ciudad Real, Cuenca, Guadalajara o Toledo. (Si la plaza es general para la Junta y no especifica ciudad, pon Toledo).
         - Si es Castilla y León, deduce la provincia real: Ávila, Burgos, León, Palencia, Salamanca, Segovia, Soria, Valladolid o Zamora. (Si la plaza es general para la Junta y no especifica ciudad, pon Valladolid).
      6. 🚨 EL SÍNDROME DEL BOE: Aunque la fuente de la noticia sea un Boletín Estatal (BOE), si el organismo es un Ayuntamiento, Universidad u Hospital, DEBES deducir la provincia física real (ej. Universitat Jaume I -> Castellón). Usa 'Estatal' ÚNICA Y EXCLUSIVAMENTE para Ministerios, Fuerzas Armadas o Cuerpos de ámbito verdaderamente nacional.
      
  - enlace_inscripcion: URL exacta para presentar instancia (sede electrónica).
  - tasa: Importe de la tasa (derechos de examen) numérico. Ej: 15.20.
  - boletin_origen_nombre: Si las bases están publicadas en otro boletín, extrae SOLO el acrónimo (ej: 'BOE', 'BOP Córdoba').
  - boletin_origen_fecha: Si menciona la fecha del boletín de origen, formato 'YYYY-MM-DD'.
  - referencia_boe_original: Código BOE oficial si existe.
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
              tipo: { type: "string", enum: ['Plazas de Nuevo Ingreso', 'Procesos de Estabilización', 'Bolsas de Empleo Temporal', 'Provisión de Puestos y Movilidad', 'Ofertas de Empleo Público (OEP)', 'IGNORAR'] },
              sistema: { type: ["string", "null"], enum: ['Oposición', 'Concurso-Oposición', 'Concurso de Méritos', 'Libre Designación', null] },
              fase: { type: ["string", "null"], enum: ['Apertura de Plazos / Convocatoria', 'Listas de Admitidos y Excluidos', 'Tribunales y Fechas de Examen', 'Calificaciones y Resultados', 'Adjudicación y Nombramientos', 'Correcciones y Modificaciones', 'Otros Trámites', null] },
              turno: { type: ["array", "null"], items: { type: "string", enum: ["Turno Libre", "Promoción Interna", "Discapacidad"] } },
              fecha_cierre_exacta: { type: ["string", "null"], description: "Formato YYYY-MM-DD" },
              distribucion_plazas: { 
                type: ["array", "null"], 
                items: { 
                  type: "object", 
                  properties: { 
                    turno: { type: "string", enum: ["Turno Libre", "Promoción Interna", "Discapacidad"] }, 
                    plazas: { type: "integer" } 
                  }, 
                  required: ["turno", "plazas"], 
                  additionalProperties: false 
                } 
              },
              ambito: { type: ["string", "null"], enum: ["Estatal", "Autonómico", "Local", "Universidades", null] },
              plazas: { type: ["integer", "null"] },
              resumen: { type: "string" },
              plazo_numero: { type: ["integer", "null"] },
              plazo_tipo: { type: ["string", "null"], enum: ['hábiles', 'naturales', 'meses', null] },
              grupo: { type: ["string", "null"], enum: ['A1', 'A2', 'B', 'C1', 'C2', 'E', null] },
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
           required: ["tipo", "sistema", "fase", "turno", "distribucion_plazas", "ambito", "plazas", "resumen", "plazo_numero", "plazo_tipo", "grupo", "profesiones", "categoria", "provincia", "titulacion", "enlace_inscripcion", "tasa", "boletin_origen_nombre", "boletin_origen_fecha", "referencia_boe_original", "fecha_cierre_exacta", "organismo", "meta_description", "enlace_pdf"],
            additionalProperties: false
          }
        }
      }
    });
    return JSON.parse(response.choices[0].message.content);
  } catch (error) {
    if (error.status === 429) {
      if (intentos > 0) {
          console.warn(`   ⏳ Límite de IA (429). Esperando 5s para reintentar...`);
          await esperar(5000);
          return analizarConvocatoriaIA(titulo, textoInterior, departamento, seccion, ambitoAutonomico);
      } else {
          console.error("❌ OpenAI no responde tras varios intentos. Saltando...");
          return [];
      }
    }
    console.error("❌ Error en analizarConvocatoriaIA:", error.message);
    return { tipo: "Otros Trámites", plazas: null, resumen: titulo };
  }
}

// ✍️ NUEVA FUNCIÓN: Redactora SEO (Alta Temperatura, Creatividad y Contexto Total 3D)
async function redactarArticuloSEOIA(datosExtraidos, textoInterior) {
  // Pasamos un fragmento de los primeros 3000 caracteres para dar contexto sin consumir tokens innecesarios
  const textoCorto = textoInterior ? textoInterior.substring(0, 3000) : "";
  
  // 🚀 MEJORA SEO: Preparamos el desglose de plazas para que la IA lo entienda fácil
  let desglosePlazas = "No especificado detalladamente";
  if (datosExtraidos.distribucion_plazas && datosExtraidos.distribucion_plazas.length > 0) {
      desglosePlazas = datosExtraidos.distribucion_plazas.map(d => `${d.plazas} plaza(s) para ${d.turno}`).join(', ');
  }

  const prompt = `
  Eres un experto redactor de contenidos SEO especializado en empleo público y oposiciones en España.
  Basándote en el siguiente JSON de datos ultra-detallados y en el fragmento del BOE/boletín, redacta un artículo sumamente atractivo, útil y único de AL MENOS 300 PALABRAS estructurado en formato Markdown.

  DATOS CLAVE EXTRAÍDOS (MATRIZ 3D):
  - Título/Profesión: ${datosExtraidos.profesiones && datosExtraidos.profesiones.length > 0 ? datosExtraidos.profesiones.join(', ') : 'Empleo Público'}
  - Organismo Convocante: ${datosExtraidos.organismo || datosExtraidos.department || 'Administración Pública'}
  - Ámbito Territorial: ${datosExtraidos.ambito || 'No especificado'}
  - Provincia: ${datosExtraidos.provincia || 'España'}
  - Categoría Profesional: ${datosExtraidos.categoria || 'No especificada'}
  - Grupo Funcional: ${datosExtraidos.grupo || 'No especificado'}
  - Naturaleza (Tipo): ${datosExtraidos.tipo || 'Oposición'} (ej. Plazas de Nuevo Ingreso, Bolsas, Estabilización)
  - Sistema de Evaluación: ${datosExtraidos.sistema || 'No especificado'} (ej. Oposición, Concurso-Oposición)
  - FASE ACTUAL: ${datosExtraidos.fase || 'Apertura de Plazos / Convocatoria'}
  - Total de Plazas: ${datosExtraidos.plazas || 'No especificadas'}
  - Desglose por Turnos: ${desglosePlazas}
  - Titulación Exigida: ${datosExtraidos.titulacion || 'Ver bases oficiales'}
  - Tasas generales: ${datosExtraidos.tasa ? datosExtraidos.tasa + ' €' : 'No especificada'}
  
  FRAGMENTO DEL BOLETÍN PARA CONTEXTO:
  "${textoCorto}"

  ESTRUCTURA OBLIGATORIA DEL TEXTO EN MARKDOWN:
  1. Introducción atractiva (Usa un H2 ##): ¡ADAPTA EL TONO A LA FASE ACTUAL! 
     - Si la fase es 'Apertura de Plazos / Convocatoria', habla de la gran oportunidad de conseguir plaza/entrar en bolsa en [Organismo] y [Provincia], animando a presentarse.
     - Si la fase es 'Listas de Admitidos...', 'Tribunales...', 'Calificaciones...' o 'Adjudicación...', informa a los opositores de que el proceso ha avanzado y diles de qué trata esta actualización.
  2. Detalles de la Convocatoria (Usa H3 ### y viñetas -): Explica el número de plazas, a qué grupo pertenecen (${datosExtraidos.grupo || ''}), si es bolsa o plaza fija (${datosExtraidos.tipo || ''}), y cómo se reparten los turnos (${desglosePlazas}).
  3. Requisitos y Titulación (Usa H3 ###): Explica quién puede presentarse según la titulación exigida.
  4. Proceso Selectivo (Usa H3 ###): Explica cómo se evaluará a los candidatos basándote en el Sistema (${datosExtraidos.sistema || ''}) y el texto del boletín.
  5. Siguientes Pasos (Usa H3 ###): Dales un consejo final sobre qué hacer a continuación según la Fase Actual en la que se encuentra el trámite.

  REGLAS:
  - El texto debe sonar natural, humano, empático y orientado a ayudar al opositor.
  - Usa variaciones de palabras clave orgánicas (Long-Tail SEO) como "oposiciones a [Profesión]", "trabajar como [Profesión] en [Provincia]", "empleo público en [Organismo]", "requisitos para [Profesión]".
  - ¡DEBES superar holgadamente las 300 palabras para evitar el 'Thin Content' en Google!
  - Devuelve SOLO el texto en Markdown. No uses etiquetas de bloque \`\`\`markdown al inicio ni al final, devuelve el texto crudo.
  - Todo el contenido DEBE estar en ESPAÑOL.
  `;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7, 
      messages: [{ role: "user", content: prompt }]
    });
    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error("❌ Error en redactarArticuloSEOIA:", error.message);
    return null;
  }
}

module.exports = {
  extraerEnlacesSumarioIA,
  analizarConvocatoriaIA,
  redactarArticuloSEOIA,
  getIaDetenida,
  setIaDetenida
};