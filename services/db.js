// ==========================================
// ARCHIVO: ./services/db.js
// ==========================================

const { createClient } = require("@supabase/supabase-js");
const slugify = require("slugify");
const { analizarConvocatoriaIA, redactarArticuloSEOIA } = require("./ai");
const { 
  calcularFechaCierre, 
  capitalizarProfesion, 
  limpiarCodificacion
} = require("../utils/helpers");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

// 🗺️ MAPA DE JURISDICCIONES PARA EVITAR ALUCINACIONES GEOGRÁFICAS DE LA IA
const JURISDICCIONES = {
  'BOCYL': ['Ávila', 'Burgos', 'León', 'Palencia', 'Salamanca', 'Segovia', 'Soria', 'Valladolid', 'Zamora', 'Castilla y León'],
  'DOGV': ['Alicante', 'Castellón', 'Valencia', 'Comunidad Valenciana'],
  'DOG': ['A Coruña', 'Lugo', 'Ourense', 'Pontevedra', 'Galicia'],
  'BOJA': ['Almería', 'Cádiz', 'Córdoba', 'Granada', 'Huelva', 'Jaén', 'Málaga', 'Sevilla', 'Andalucía'],
  'BOC': ['Las Palmas', 'Santa Cruz de Tenerife', 'Canarias'],
  'BOR': ['La Rioja'],
  'BORM': ['Murcia'],
  'BOCM': ['Madrid', 'Comunidad de Madrid'],
  'BON': ['Navarra'],
  'DOE': ['Badajoz', 'Cáceres', 'Extremadura'],
  'BOIB': ['Illes Balears', 'Baleares'],
  'BOA': ['Huesca', 'Teruel', 'Zaragoza', 'Aragón'],
  'BOPA': ['Asturias'],
  'BOCAN': ['Cantabria'],
  'DOCM': ['Albacete', 'Ciudad Real', 'Cuenca', 'Guadalajara', 'Toledo', 'Castilla-La Mancha']
};

async function gestionarDepartamento(nombre) {
  if (!nombre) return;
  const slugDep = slugify(nombre, { lower: true, strict: true, remove: /[*+~.()'"!:@]/g });
  await supabase.from('departments').upsert({ name: nombre, slug: slugDep }, { onConflict: 'slug', ignoreDuplicates: true });
}

// --- 6. LÓGICA DE BASE DE DATOS ---
async function procesarYGuardarConvocatoria(itemData, textoParaIA, fuente, convocatoriasInsertadasHoy, statsFuente) {
  if (!textoParaIA || textoParaIA.length < 50) {
      statsFuente.errores++;
      return;
  }
  // 🚀 PARCHE BOJA: Limpiar la cadena conflictiva
  textoParaIA = textoParaIA.replace(/\[Descargar PDF\]/gi, '').trim();

  const textoLower = textoParaIA.toLowerCase();
  if (textoLower.includes("error 404") || textoLower.includes("página no encontrada") || textoLower.includes("page not found")) {
      console.log(`   ⏭️ Ignorado: La web de destino devolvió un Error 404.`);
      statsFuente.descartadas_404++;
      return;
  }

  // 🧠 Llamada al Cerebro de la Matriz 3D
  const analisisIA = await analizarConvocatoriaIA(itemData.title, textoParaIA, itemData.department, itemData.section, fuente.ambito);

  // 🧮 AUTOCORRECCIÓN MATEMÁTICA: Agrupar y sumar distribución de plazas
  if (analisisIA.distribucion_plazas && Array.isArray(analisisIA.distribucion_plazas)) {
      const agrupado = {};
      let sumaTotal = 0;
      
      for (const item of analisisIA.distribucion_plazas) {
          if (item.turno && typeof item.plazas === 'number') {
              agrupado[item.turno] = (agrupado[item.turno] || 0) + item.plazas;
              sumaTotal += item.plazas;
          }
      }
      
      // Transformamos el objeto de nuevo al formato JSON Array
      analisisIA.distribucion_plazas = Object.keys(agrupado).map(turno => ({
          turno: turno,
          plazas: agrupado[turno]
      }));

      // Parche de seguridad: Si la IA falló sumando el total, lo pisamos con la suma real
      if (sumaTotal > 0 && analisisIA.plazas !== sumaTotal) {
          analisisIA.plazas = sumaTotal;
      }
  }

  if (analisisIA.tipo === "IGNORAR" || (analisisIA.resumen && analisisIA.resumen.toLowerCase().includes("convenio"))) {
      console.log(`   ⏭️ Ignorado: La IA detectó que es un convenio o trámite no relevante.`);
      statsFuente.descartadas_ia++;
      return;
  }

  let profesionPrincipal = (analisisIA.profesiones && analisisIA.profesiones.length > 0) ? analisisIA.profesiones[0] : null;
  
  // 🚀 APLICAMOS EL FORMATO 'TITLE CASE' A LAS PROFESIONES
  profesionPrincipal = capitalizarProfesion(profesionPrincipal);
  if (analisisIA.profesiones) {
      analisisIA.profesiones = analisisIA.profesiones.map(capitalizarProfesion);
  }
  
  // Condición de seguridad adaptada a la nueva matriz
  if (!profesionPrincipal && !analisisIA.plazas && analisisIA.fase === "Otros Trámites") {
      console.log(`   ⏭️ Descartado: La IA determinó que es un trámite genérico sin plazas ni profesiones.`);
      statsFuente.descartadas_ia++;
      return;
  }

  // --- 🛡️ VALIDACIÓN DE INTEGRIDAD TERRITORIAL ---
  let provinciaValidada = analisisIA.provincia || fuente.ambito;
  if (JURISDICCIONES[fuente.nombre]) {
      const permitidas = JURISDICCIONES[fuente.nombre];
      if (!permitidas.includes(provinciaValidada)) {
          console.log(`   ⚠️ Alucinación Geográfica: ${provinciaValidada} no pertenece a ${fuente.nombre}. Corrigiendo...`);
          provinciaValidada = permitidas[permitidas.length - 1]; // Forzamos a la Comunidad Autónoma
      }
  }

  const departamentoFinal = analisisIA.organismo || itemData.department;
  let parentSlug = null;
  
  // ⚠️ NUEVOS TIPOS MATRIZ 3D para definir si es un Trámite (para buscar padre) o una Plaza Nueva
  const tiposNuevos = ['Plazas de Nuevo Ingreso', 'Procesos de Estabilización', 'Bolsas de Empleo Temporal', 'Provisión de Puestos y Movilidad'];
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

  // 🥈 PRIORIDAD 2: Fuzzy Matching (Delegado a PostgreSQL)
  if (!parentSlug && departamentoFinal && profesionPrincipal) {
    
    const { data: posiblesPadres, error: rpcError } = await supabase
      .rpc('buscar_padre_fuzzy', {
        p_departamento: departamentoFinal,
        p_profesion: profesionPrincipal,
        p_provincia: provinciaValidada, // Usamos la provincia blindada
        p_umbral: 0.85                
      });

    if (rpcError) {
        console.error("   ❌ Error en RPC buscar_padre_fuzzy:", rpcError.message);
    } else if (posiblesPadres && posiblesPadres.length > 0) {
      let plazaExistente = posiblesPadres[0]; 

      // 🚀 PARCHE VITAL: RECUPERACIÓN DE DATOS FALTANTES (¡AHORA CON SCOPE GLOBAL!)
      let tituloPadre = '';
      let boletinPadre = '';
      let resumenPadre = '';

      if (plazaExistente) {
          // Asignaciones preventivas por si falla el fetch
          tituloPadre = plazaExistente.title || '';
          boletinPadre = plazaExistente.boletin || '';

          const { data: extraData } = await supabase.from('convocatorias')
              .select('title, boletin, grupo, type, sistema, fase, resumen') 
              .eq('slug', plazaExistente.slug)
              .single();
              
          if (extraData) {
              plazaExistente.title = extraData.title;
              plazaExistente.boletin = extraData.boletin;
              plazaExistente.grupo = extraData.grupo;
              plazaExistente.type = extraData.type; 
              plazaExistente.sistema = extraData.sistema; 
              plazaExistente.fase = extraData.fase; 
              
              tituloPadre = extraData.title || '';
              boletinPadre = extraData.boletin || '';
              resumenPadre = extraData.resumen || '';
          }
      }

      // 🛡️ 0. ESCUDO ESTRICTO DE AYUNTAMIENTOS
      if (plazaExistente) {
          const deptNuevo = departamentoFinal.toLowerCase();
          const deptViejo = plazaExistente.department.toLowerCase();
          
          if (deptNuevo.includes('ayuntamiento') && deptViejo.includes('ayuntamiento')) {
              if (deptNuevo !== deptViejo) {
                  console.log(`   🏛️ Salvado de deduplicación: Confusión de Ayuntamientos (${deptNuevo} vs ${deptViejo}).`);
                  plazaExistente = null;
              }
          }
      }

      // 🛡️ 1. ESCUDO ANTIMEZCLAS DE TURNOS
      if (plazaExistente) {
          const turnoNuevoStr = Array.isArray(analisisIA.turno) ? [...analisisIA.turno].sort().join(',') : 'Turno Libre';
          
          let turnoAntiguoArray = [];
          if (Array.isArray(plazaExistente.turno)) {
              turnoAntiguoArray = plazaExistente.turno;
          } else if (typeof plazaExistente.turno === 'string') {
              try { turnoAntiguoArray = JSON.parse(plazaExistente.turno); } 
              catch(e) { turnoAntiguoArray = [plazaExistente.turno]; }
          }
          
          const turnoAntiguoStr = turnoAntiguoArray.length > 0 ? [...turnoAntiguoArray].sort().join(',') : 'Turno Libre';

          if (turnoNuevoStr !== turnoAntiguoStr) {
              console.log(`   ⚖️ Salvado: Alta similitud pero TURNOS DISTINTOS (${turnoNuevoStr} vs ${turnoAntiguoStr})`);
              plazaExistente = null; 
          }
      }

      // 🛡️ 1.5 ESCUDO DE GRUPO PROFESIONAL
      if (plazaExistente) {
          const grupoNuevo = analisisIA.grupo || '';
          const grupoViejo = plazaExistente.grupo || '';
          
          if (grupoNuevo && grupoViejo && grupoNuevo !== grupoViejo) {
              console.log(`   🔠 Salvado de deduplicación: Pertenecen a Grupos distintos (${grupoNuevo} vs ${grupoViejo}).`);
              plazaExistente = null;
          }
      }

      // 🛡️ 1.8 ESCUDO DE NATURALEZA Y SISTEMA (Anti-Mutaciones)
      if (plazaExistente) {
          const tipoNuevo = analisisIA.tipo || '';
          const tipoViejo = plazaExistente.type || '';
          const sistemaNuevo = analisisIA.sistema || '';
          const sistemaViejo = plazaExistente.sistema || '';

          if (tipoNuevo && tipoViejo && tipoNuevo !== tipoViejo) {
              console.log(`   🧬 Salvado de deduplicación: Naturaleza distinta (${tipoNuevo} vs ${tipoViejo}).`);
              plazaExistente = null;
          }
          else if (sistemaNuevo && sistemaViejo && sistemaNuevo !== sistemaViejo) {
              console.log(`   ⚖️ Salvado de deduplicación: Sistema de evaluación distinto (${sistemaNuevo} vs ${sistemaViejo}).`);
              plazaExistente = null;
          }
      }

      // 🛡️ 3.7 ESCUDO DE ESPECIALIDADES MÉDICAS Y DOCENTES (Anti-Fuzzy Avanzado)
      if (plazaExistente && (analisisIA.categoria === 'Sanidad y Salud' || analisisIA.categoria === 'Educación y Docencia')) {
          let especialidadesDiferentes = false;
          const profNueva = profesionPrincipal ? profesionPrincipal.toLowerCase() : '';
          const profVieja = plazaExistente.profesion ? plazaExistente.profesion.toLowerCase() : '';
          
          if (profNueva && profVieja && profNueva !== profVieja) {
              especialidadesDiferentes = true;
          }

          const extraerEspecialidad = (texto) => {
              if (!texto) return "";
              const match = texto.match(/(?:especialidad|especialista en)\s+([^,]+)/i);
              return match ? match[1].trim().toLowerCase() : "";
          };

          const espNueva = extraerEspecialidad(itemData.title);
          const espVieja = extraerEspecialidad(tituloPadre);

          if (espNueva && espVieja && espNueva !== espVieja) {
              especialidadesDiferentes = true;
          }
          
          const palabrasCriticas = ['psiquiatría', 'pediatría', 'geriatría', 'neumología', 'neurología', 'cardiología', 'radiología', 'urología', 'oncología'];
          const tNuevo = `${profNueva} ${itemData.title.toLowerCase()}`;
          const tViejo = `${profVieja} ${tituloPadre ? tituloPadre.toLowerCase() : ''}`;
          
          for (let palabra of palabrasCriticas) {
              if (tNuevo.includes(palabra) !== tViejo.includes(palabra)) {
                  especialidadesDiferentes = true;
                  break;
              }
          }

          if (especialidadesDiferentes) {
              console.log(`   🩺 Salvado de deduplicación: Especialidades distintas (${espNueva || profNueva} vs ${espVieja || profVieja}).`);
              plazaExistente = null;
          }
      }

      // ⏱️ 2. ESCUDO CRONOLÓGICO EVOLUTIVO (Motor de rangos)
      let rangoNuevo = 0;
      let rangoPadre = 0;
      
      if (plazaExistente) {
          const RANGOS = {
              'Apertura de Plazos / Convocatoria': 1,
              'Listas de Admitidos y Excluidos': 2,
              'Tribunales y Fechas de Examen': 3,
              'Calificaciones y Resultados': 4,
              'Adjudicación y Nombramientos': 5,
              'Correcciones y Modificaciones': 0, 
              'Otros Trámites': 0
          };

          rangoNuevo = RANGOS[analisisIA.fase] || 0;
          rangoPadre = RANGOS[plazaExistente.fase] || 0;

          if (rangoNuevo > 0 && rangoPadre > 0 && rangoNuevo < rangoPadre) {
              console.log(`   ⏱️ Salvado: La plaza encontrada está más avanzada (${plazaExistente.fase}) que el documento actual (${analisisIA.fase}).`);
              plazaExistente = null; 
          }
      }

      // 👯 3. ESCUDO DE RESOLUCIONES GEMELAS (Anti-Clones y Nombres Regionales)
      if (plazaExistente && rangoNuevo === rangoPadre && rangoNuevo > 0) {
          const mismoBoletin = boletinPadre && boletinPadre.startsWith(fuente.nombre);
          
          if (mismoBoletin) {
              console.log(`   👯 Salvado: Resoluciones gemelas en el mismo boletín (${fuente.nombre}). Son plazas distintas.`);
              plazaExistente = null;
          } else {
              const extraerParentesis = (texto) => {
                  if (!texto) return "";
                  return (texto.match(/\(([^)]+)\)/g) || []).join(' ').toLowerCase();
              };
              
              // Buscamos paréntesis tanto en el título bruto como en el resumen procesado por la IA y en los primeros 1000 caracteres del texto real
              const textoHijoCompleto = `${itemData.title || ''} ${analisisIA.resumen || ''} ${(textoParaIA || '').substring(0, 1000)}`;
              const textoPadreCompleto = `${tituloPadre} ${resumenPadre}`;

              const parenNuevo = extraerParentesis(textoHijoCompleto);
              const parenViejo = extraerParentesis(textoPadreCompleto);
              
              if (parenNuevo && parenViejo && parenNuevo !== parenViejo) {
                  console.log(`   📍 Salvado: Localizaciones o paréntesis difieren (${parenNuevo} vs ${parenViejo}).`);
                  plazaExistente = null;
              }
          }
      }

      // 🪪 3.5 ESCUDO DE CÓDIGOS DE EXPEDIENTE / RESOLUCIÓN
      if (plazaExistente) {
          const extraerCodigo = (texto) => {
              if (!texto) return "";
              // Ampliamos la regex para capturar formatos como ADC-EDU-69/26, 123/2026, R-462/2026, 52/25
              const match = texto.match(/[A-Z0-9-]*\d{1,4}\/\d{2,4}/i);
              return match ? match[0].toLowerCase() : "";
          };
          
          // Buscamos el código también en los primeros 1000 caracteres del texto real (el PDF/HTML)
          const textoHijoCod = `${itemData.title || ''} ${(textoParaIA || '').substring(0, 1000)}`;
          
          const codNuevo = extraerCodigo(textoHijoCod);
          const codViejo = extraerCodigo(tituloPadre);
          
          if (codNuevo && codViejo && codNuevo !== codViejo) {
              console.log(`   🪪 Salvado de deduplicación: Códigos de expediente distintos (${codNuevo} vs ${codViejo}).`);
              plazaExistente = null;
          }
      }

      // 🛡️ 4. ESCUDO UNIVERSAL DE FASES IDÉNTICAS (Super-Gemelas)
      if (plazaExistente) {
          if (analisisIA.fase && plazaExistente.fase && analisisIA.fase === plazaExistente.fase) {
              const mismoBoletin = boletinPadre && boletinPadre.startsWith(fuente.nombre);
              if (mismoBoletin) {
                  console.log(`   🚫 Salvado de deduplicación: Tienen la misma fase (${analisisIA.fase}) en el MISMO boletín (${fuente.nombre}). Son procesos paralelos.`);
                  plazaExistente = null;
              } else {
                  console.log(`   🤝 Excepción Mixta: Tienen la misma fase, pero provienen de boletines distintos (${fuente.nombre} y ${boletinPadre}). Se enlazan.`);
              }
          }
      }

      // 🚀 AHORA SÍ: LÓGICA DE HISTORIAL DE PUBLICACIONES (VERSIÓN INMUTABLE)
      if (plazaExistente) {
        if (esTramite) {
          console.log(`   🔗 Trámite enlazado por Trigramas (${(plazaExistente.similitud * 100).toFixed(0)}%). Padre: ${plazaExistente.slug}`);
          parentSlug = plazaExistente.slug;
          statsFuente.enlazadas++; 
        } else {
          console.log(`   📖 Historial detectado (${(plazaExistente.similitud * 100).toFixed(0)}%): Vinculando nueva publicación al boletín original: ${plazaExistente.slug}`);
          parentSlug = plazaExistente.slug;
          statsFuente.enlazadas++; 
        }
      }
    }
  }

  let textoPlazas = analisisIA.plazas ? (analisisIA.plazas === 1 ? '1-plaza-' : `${analisisIA.plazas}-plazas-`) : '';
  const sufijoDep = departamentoFinal ? `-${departamentoFinal}` : '-administracion-publica';
  let textoParaSlug = profesionPrincipal ? `oposiciones-${textoPlazas}${profesionPrincipal}${sufijoDep}` : (analisisIA.resumen || itemData.title);
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
  let slugFinal = `${slugBase}-${suffix}`;

  // 🐍 5. ESCUDO OUROBOROS (Anti-Canibalismo)
  // Evita que un hijo devore a su padre si las URLs de la administración generan el mismo sufijo
  if (parentSlug && slugFinal.toLowerCase() === parentSlug.toLowerCase()) {
      console.log(`   🐍 ALERTA OUROBOROS: El hijo ha generado el mismo slug que el padre. Mutando el slug...`);
      // Le inyectamos el nombre de la fase al slug para garantizar que el hijo sea independiente
      const faseLimpia = slugify(analisisIA.fase || 'tramite', { lower: true, strict: true }).substring(0, 12);
      slugFinal = `${slugBase}-${faseLimpia}-${suffix}`;
  }

  // =========================================================================
  // ✍️ 🚀 EJECUCIÓN DE LA REDACTORA SEO
  // =========================================================================
  // Ahora redactamos SEO también para Admitidos y Calificaciones para que las hijas posicionen bien en Google
  let descripcionSEO = null;
  const fasesSEO = ['Apertura de Plazos / Convocatoria', 'Listas de Admitidos y Excluidos', 'Calificaciones y Resultados'];
  
  if (!esTramite || fasesSEO.includes(analisisIA.fase)) {
      console.log(`   ✍️ Redactando artículo SEO extenso para: ${profesionPrincipal || 'Plaza'}...`);
      descripcionSEO = await redactarArticuloSEOIA(analisisIA, textoParaIA);
  }
  // =========================================================================

  // --- 🛠️ ASIGNACIÓN DEFINITIVA DE ENLACES (link_boe y guid) ---
  let webDefinitiva = itemData.htmlGenerado || itemData.link;
  let pdfDefinitivo = itemData.pdfGenerado || itemData.pdf_rss || itemData.pdf_extraido || analisisIA.enlace_pdf;

  if (webDefinitiva.includes('{')) {
      webDefinitiva = itemData.link_boletin;
  }

  // DOE (Extremadura)
  let enlaceBaseDoe = pdfDefinitivo || webDefinitiva || "";
  if (fuente.nombre === "DOE" && enlaceBaseDoe.includes('.pdf')) {
      const matchDoe = enlaceBaseDoe.match(/\/doe\/(\d{4})\/([^/]+)\/(\d+)\.pdf/i);
      if (matchDoe && matchDoe.length === 4) {
          webDefinitiva = `https://doe.juntaex.es/otrosFormatos/html.php?xml=20${matchDoe[3]}&anio=${matchDoe[1]}&doe=${matchDoe[2]}`;
          pdfDefinitivo = enlaceBaseDoe; 
      }
  }

  // BOIB (Baleares)
  if (fuente.nombre === "BOIB" && pdfDefinitivo && pdfDefinitivo.includes('/eboibfront/pdf/')) {
      const matchPdf = pdfDefinitivo.match(/\/eboibfront\/pdf\/.+/);
      if (matchPdf) {
          pdfDefinitivo = "https://www.caib.es" + matchPdf[0];
      }
  }

  // BON (Navarra)
  if (fuente.nombre === "BON") {
      pdfDefinitivo = webDefinitiva;
  }

  if (!pdfDefinitivo) pdfDefinitivo = webDefinitiva;
  if (!webDefinitiva) webDefinitiva = pdfDefinitivo;

// --- 🛡️ ESCUDO MATEMÁTICO ABSOLUTO PARA FECHAS DE CIERRE ---
  const formatterMadrid = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' });
    const fechaPublicacionReal = itemData.fecha_publicacion_real || formatterMadrid.format(new Date());
  
  // REGLA DE HIERRO: Si el texto indica que hay un "plazo_numero" (ej: 15 días, 1 mes),
  // se anula SIEMPRE cualquier fecha de cierre exacta que la IA haya intentado deducir.
  // La IA es pésima sumando días hábiles, así que obligamos al sistema a usar la función calcularFechaCierre() de helpers.js.
  if (analisisIA.plazo_numero > 0) {
      if (analisisIA.fecha_cierre_exacta) {
          console.log(`   🛡️ Escudo Fechas: Anulando fecha exacta de la IA (${analisisIA.fecha_cierre_exacta}) para delegar el cálculo matemático de los ${analisisIA.plazo_numero} ${analisisIA.plazo_tipo}.`);
          analisisIA.fecha_cierre_exacta = null;
      }
  }

  // Ahora, calcularFechaCierre se ejecutará obligatoriamente siempre que haya días/meses de plazo.
  const fechaCierreCalculada = analisisIA.fecha_cierre_exacta || calcularFechaCierre(fechaPublicacionReal, analisisIA.plazo_numero, analisisIA.plazo_tipo, provinciaValidada);

  // 📦 CONSTRUCCIÓN DEL OBJETO DEFINITIVO
  const convocatoria = {
    slug: slugFinal, 
    title: limpiarCodificacion(itemData.title), 
    meta_description: limpiarCodificacion(analisisIA.meta_description || (analisisIA.resumen ? analisisIA.resumen.substring(0, 150) + "..." : "Ver detalles.")),
    descripcion_extendida: limpiarCodificacion(descripcionSEO),
    section: itemData.section, 
    department: departamentoFinal, 
    boletin: `${fuente.nombre} - ${fuente.ambito}`,
    parent_type: "OPOSICION", 

    type: analisisIA.tipo, 
    fase: analisisIA.fase,
    sistema: analisisIA.sistema,
    turno: analisisIA.turno, 
    distribucion_plazas: analisisIA.distribucion_plazas, 
    ambito: analisisIA.ambito, 

    plazas: analisisIA.plazas, 
    resumen: limpiarCodificacion(analisisIA.resumen),
    plazo_numero: analisisIA.plazo_numero,
    plazo_tipo: analisisIA.plazo_tipo,
    fecha_cierre: fechaCierreCalculada,
    boletin_origen_nombre: analisisIA.boletin_origen_nombre,
    boletin_origen_fecha: analisisIA.boletin_origen_fecha,
    referencia_boe_original: analisisIA.referencia_boe_original,
    plazo_texto: (analisisIA.plazo_numero && analisisIA.plazo_tipo) ? `${analisisIA.plazo_numero} días ${analisisIA.plazo_tipo}` : null,
    referencia_bases: (analisisIA.boletin_origen_nombre && analisisIA.boletin_origen_fecha) ? `${analisisIA.boletin_origen_nombre} | ${analisisIA.boletin_origen_fecha}` : null,
    grupo: analisisIA.grupo, 
    profesion: profesionPrincipal, 
    profesiones: analisisIA.profesiones,
    categoria: analisisIA.categoria,
    provincia: provinciaValidada, 
    titulacion: analisisIA.titulacion, 
    enlace_inscripcion: analisisIA.enlace_inscripcion, 
    tasa: analisisIA.tasa,
    parent_slug: parentSlug, 
    publication_date: fechaPublicacionReal, 
    link_boe: webDefinitiva, 
    guid: pdfDefinitivo,
    raw_text: textoParaIA, 
  };

  const { data, error } = await supabase.from("convocatorias").upsert(convocatoria, { onConflict: "slug" }).select('id, slug, title, type, fase, plazas, department, profesion, provincia, fecha_cierre');
  
  if (error) {
    console.error(`❌ Error BD:`, error.message);
    statsFuente.errores++;
  } else {
    await gestionarDepartamento(departamentoFinal);
    console.log(`✅ Guardado -> ${fuente.nombre} | Fase: ${analisisIA.fase} | Tipo: ${analisisIA.tipo} | Org: ${departamentoFinal} | Slug: ${slugFinal} | 🔗 ${webDefinitiva}`);
    statsFuente.guardadas++; 
    if (data && data.length > 0) convocatoriasInsertadasHoy.push(data[0]);
  }
}

module.exports = {
  supabase,
  gestionarDepartamento,
  procesarYGuardarConvocatoria
};