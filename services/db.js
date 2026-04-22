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

      // 🛡️ 0. ESCUDO ESTRICTO DE AYUNTAMIENTOS
      // Si ambos organismos son Ayuntamientos, exigimos coincidencia EXACTA del nombre.
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

      // 👯 3. ESCUDO DE RESOLUCIONES GEMELAS (Anti-Clones)
      if (plazaExistente && rangoNuevo === rangoPadre && rangoNuevo > 0) {
          const mismoBoletin = plazaExistente.boletin && plazaExistente.boletin.startsWith(fuente.nombre);
          
          if (mismoBoletin) {
              console.log(`   👯 Salvado: Resoluciones gemelas en el mismo boletín (${fuente.nombre}). Son plazas distintas.`);
              plazaExistente = null;
          } else {
              const extraerParentesis = (texto) => {
                  if (!texto) return "";
                  return (texto.match(/\(([^)]+)\)/g) || []).join(' ').toLowerCase();
              };
              
              const parenNuevo = extraerParentesis(itemData.title);
              const parenViejo = extraerParentesis(plazaExistente.title);
              
              if (parenNuevo && parenViejo && parenNuevo !== parenViejo) {
                  console.log(`   📍 Salvado: Localizaciones difieren (${parenNuevo} vs ${parenViejo}).`);
                  plazaExistente = null;
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
          // 🚫 SE ELIMINA LA SINCRONIZACIÓN RETROSPECTIVA: La base de datos es ahora inmutable.
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
  const slugFinal = `${slugBase}-${suffix}`;

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

  // FECHAS
  const fechaPublicacionReal = itemData.fecha_publicacion_real || new Date().toISOString().split('T')[0];
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