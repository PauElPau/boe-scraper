// ==========================================
// ARCHIVO: ./services/db.js (o donde esté ubicado)
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
  
  // Condición de seguridad antigua, adaptada a la nueva matriz (si no hay profe ni plaza y es "Otros Trámites", adiós).
  if (!profesionPrincipal && !analisisIA.plazas && analisisIA.fase === "Otros Trámites") {
      console.log(`   ⏭️ Descartado: La IA determinó que es un trámite genérico sin plazas ni profesiones.`);
      statsFuente.descartadas_ia++;
      return;
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
    
    // 📍 Usamos la provincia extraída por la IA (o el ámbito por defecto de la fuente)
    const provinciaFiltro = analisisIA.provincia || fuente.ambito;

    // Llamamos a la función RPC de Supabase (Súper rápido)
    const { data: posiblesPadres, error: rpcError } = await supabase
      .rpc('buscar_padre_fuzzy', {
        p_departamento: departamentoFinal,
        p_profesion: profesionPrincipal,
        p_provincia: provinciaFiltro, // 🛡️ Filtro Quirúrgico por Provincia
        p_umbral: 0.85                // 🚀 Mantenemos el umbral estricto al 85%
      });

    if (rpcError) {
        console.error("   ❌ Error en RPC buscar_padre_fuzzy:", rpcError.message);
    } else if (posiblesPadres && posiblesPadres.length > 0) {
      let plazaExistente = posiblesPadres[0]; // Tomamos el mejor resultado (el #1)

      // 🛡️ ESCUDO ANTIMEZCLAS DE TURNOS
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
          console.log(`   ⚖️ Salvado de deduplicación: Alta similitud (${(plazaExistente.similitud * 100).toFixed(0)}%) pero TURNOS DISTINTOS (${turnoNuevoStr} vs ${turnoAntiguoStr})`);
          plazaExistente = null; // Anulamos la coincidencia
      }

      // 🚀 AHORA SÍ: NUEVA LÓGICA DE HISTORIAL DE PUBLICACIONES
      if (plazaExistente) {
        if (esTramite) {
          console.log(`   🔗 Trámite enlazado por Trigramas (${(plazaExistente.similitud * 100).toFixed(0)}%). Padre: ${plazaExistente.slug}`);
          parentSlug = plazaExistente.slug;
          statsFuente.enlazadas++; 
        } else {
          // Ya no es un "Duplicado evitado", es un "Historial detectado"
          console.log(`   📖 Historial detectado (${(plazaExistente.similitud * 100).toFixed(0)}%): Vinculando nueva publicación al boletín original: ${plazaExistente.slug}`);
          
          // Enlazamos la nueva fila al padre para crear la cronología
          parentSlug = plazaExistente.slug;
          statsFuente.enlazadas++; // Lo contamos como enlazada
          
          // Por si acaso, le inyectamos el link del BOE al padre original (para retrocompatibilidad en el frontend)
          if (fuente.nombre === "BOE" && !plazaExistente.link_boe) {
              await supabase.from("convocatorias").update({ 
                  link_boe: itemData.link 
              }).eq('slug', plazaExistente.slug);
          }
          
          // 🛑 AQUÍ ESTÁ LA MAGIA: Hemos eliminado el 'return;'
          // Al no abortar, el código seguirá bajando, calculará las fechas correctamente,
          // redactará el texto SEO y hará el INSERT de esta nueva fila en la base de datos.
        }
      }
    }
  }

  let textoPlazas = analisisIA.plazas ? (analisisIA.plazas === 1 ? '1-plaza-' : `${analisisIA.plazas}-plazas-`) : '';
  // Creamos un sufijo seguro. Si no hay departamento, ponemos "administracion-publica" para el SEO.
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
  // ✍️ 🚀 EJECUCIÓN DE LA REDACTORA SEO (Solo para las que sobrevivieron)
  // =========================================================================
  // Solo generamos artículos largos para aperturas reales, no para "Trámites" menores, 
  // así ahorramos dinero en la API. Si es un trámite, la descripcion_extendida será null.
  let descripcionSEO = null;
  if (!esTramite || analisisIA.fase === 'Apertura de Plazos / Convocatoria') {
      console.log(`   ✍️ Redactando artículo SEO extenso para: ${profesionPrincipal || 'Plaza'}...`);
      descripcionSEO = await redactarArticuloSEOIA(analisisIA, textoParaIA);
  }
  // =========================================================================

  // --- 🛠️ ASIGNACIÓN DEFINITIVA DE ENLACES (link_boe y guid) ---
  // 1. Asignamos el HTML principal (link_boe)
  let webDefinitiva = itemData.htmlGenerado || itemData.link;
  
  // 2. Asignamos el PDF principal (guid)
  let pdfDefinitivo = itemData.pdfGenerado || itemData.pdf_rss || itemData.pdf_extraido || analisisIA.enlace_pdf;

  // 3. REGLAS DE SEGURIDAD Y LIMPIEZA
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

  // Fallback de seguridad
  if (!pdfDefinitivo) pdfDefinitivo = webDefinitiva;
  if (!webDefinitiva) webDefinitiva = pdfDefinitivo;
  // ----------------------------------------------------------

/*   const fechaPublicacionHoy = new Date().toISOString().split('T')[0];
  const fechaCierreCalculada = calcularFechaCierre(fechaPublicacionHoy, analisisIA.plazo_numero, analisisIA.plazo_tipo); */

  // 1. Usamos la fecha real que nos llega del engine (o la de hoy por defecto)
  const fechaPublicacionReal = itemData.fecha_publicacion_real || new Date().toISOString().split('T')[0];
  
  // 2. Si la IA logró encontrar una fecha exacta escrita en el texto, la usamos. 
  // Si no, delegamos en tu cálculo matemático de días hábiles/naturales.
  // Usamos la provincia extraída por la IA (o la genérica de la fuente si la IA falló)
  const provinciaCalculo = analisisIA.provincia || fuente.ambito;

  const fechaCierreCalculada = analisisIA.fecha_cierre_exacta || calcularFechaCierre(fechaPublicacionReal, analisisIA.plazo_numero, analisisIA.plazo_tipo, provinciaCalculo);

  // 📦 AHORA SÍ: Construimos el objeto definitivo con la Matriz 3D
  const convocatoria = {
    slug: slugFinal, 
    title: limpiarCodificacion(itemData.title), 
    meta_description: limpiarCodificacion(analisisIA.meta_description || (analisisIA.resumen ? analisisIA.resumen.substring(0, 150) + "..." : "Ver detalles.")),
    descripcion_extendida: limpiarCodificacion(descripcionSEO),
    section: itemData.section, 
    department: departamentoFinal, 
    boletin: `${fuente.nombre} - ${fuente.ambito}`,
    parent_type: "OPOSICION", 

    // 🏗️ Inyección de la Matriz 3D Completa
    type: analisisIA.tipo, // La BD se llama type
    fase: analisisIA.fase,
    sistema: analisisIA.sistema,
    turno: analisisIA.turno, // Esto ahora es un Array
    distribucion_plazas: analisisIA.distribucion_plazas, // El array de objetos para desgloses
    ambito: analisisIA.ambito, // Territorial

    plazas: analisisIA.plazas, 
    resumen: limpiarCodificacion(analisisIA.resumen),
    plazo_numero: analisisIA.plazo_numero,
    plazo_tipo: analisisIA.plazo_tipo,
    fecha_cierre: fechaCierreCalculada,
    boletin_origen_nombre: analisisIA.boletin_origen_nombre,
    boletin_origen_fecha: analisisIA.boletin_origen_fecha,
    referencia_boe_original: analisisIA.referencia_boe_original, // Faltaba esto para que enlace tramites BOE
    plazo_texto: (analisisIA.plazo_numero && analisisIA.plazo_tipo) ? `${analisisIA.plazo_numero} días ${analisisIA.plazo_tipo}` : null,
    referencia_bases: (analisisIA.boletin_origen_nombre && analisisIA.boletin_origen_fecha) ? `${analisisIA.boletin_origen_nombre} | ${analisisIA.boletin_origen_fecha}` : null,
    grupo: analisisIA.grupo, 
    profesion: profesionPrincipal, 
    profesiones: analisisIA.profesiones,
    categoria: analisisIA.categoria,
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

  const { data, error } = await supabase.from("convocatorias").upsert(convocatoria, { onConflict: "slug" }).select('id, slug, title, type, fase, plazas, department, profesion, provincia, fecha_cierre');
  
  if (error) {
    console.error(`❌ Error BD:`, error.message);
    statsFuente.errores++;
  } else {
    await gestionarDepartamento(departamentoFinal);
    // Print bonito en la consola para confirmar que funciona
    console.log(`✅ Guardado -> ${fuente.nombre} | Fase: ${analisisIA.fase} | Tipo: ${analisisIA.tipo} | Org: ${departamentoFinal} | Slug: ${slugFinal} | 🔗 ${webDefinitiva}`);
    statsFuente.guardadas++; // Sumamos como guardada final
    if (data && data.length > 0) convocatoriasInsertadasHoy.push(data[0]);
  }
}

module.exports = {
  supabase,
  gestionarDepartamento,
  procesarYGuardarConvocatoria
};