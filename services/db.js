const { createClient } = require("@supabase/supabase-js");
const slugify = require("slugify");
const { analizarConvocatoriaIA } = require("./ai");
const { 
  calcularFechaCierre, 
  capitalizarProfesion, 
  limpiarCodificacion, 
  limpiarPalabraParaFuzzy 
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

  const analisisIA = await analizarConvocatoriaIA(itemData.title, textoParaIA, itemData.department, itemData.section, fuente.ambito);

 
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
      .select('slug, type, link_boe, profesion, profesiones, turno')
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
            // 🚀 Exigimos un 80% de coincidencia semántica para evitar agrupar especialidades médicas distintas
            return (coincidencias / palabrasClave.length) >= 0.8;
          });
      }

      // 🛡️ INICIO DEL ESCUDO ANTIMEZCLAS DE TURNOS
      if (plazaExistente) {
          const turnoNuevo = analisisIA.turno || 'Turno Libre';
          const turnoAntiguo = plazaExistente.turno || 'Turno Libre';

          if (turnoNuevo !== turnoAntiguo) {
              console.log(`   ⚖️ Salvado de deduplicación: Títulos similares pero TURNOS DISTINTOS (${turnoNuevo} vs ${turnoAntiguo})`);
              plazaExistente = null; // Anulamos la coincidencia para forzar que se inserte como nueva
          }
      }
      // 🛡️ FIN DEL ESCUDO

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

  
  // --- 🛠️ ASIGNACIÓN DEFINITIVA DE ENLACES (link_boe y guid) ---
  
  // 1. Asignamos el HTML principal (link_boe)
  let webDefinitiva = itemData.htmlGenerado || itemData.link;
  
  // 2. Asignamos el PDF principal (guid)
  // 🚨 ORDEN CRÍTICO: El código estricto prevalece. La IA es la última opción.
  let pdfDefinitivo = itemData.pdfGenerado || itemData.pdf_rss || itemData.pdf_extraido || analisisIA.enlace_pdf;


  // 3. REGLAS DE SEGURIDAD Y LIMPIEZA
  if (webDefinitiva.includes('{')) {
      webDefinitiva = itemData.link_boletin;
  }

  // DOE (Extremadura): Reconstruir HTML desde el PDF (esté donde esté el enlace)
  let enlaceBaseDoe = pdfDefinitivo || webDefinitiva || "";
  if (fuente.nombre === "DOE" && enlaceBaseDoe.includes('.pdf')) {
      const matchDoe = enlaceBaseDoe.match(/\/doe\/(\d{4})\/([^/]+)\/(\d+)\.pdf/i);
      if (matchDoe && matchDoe.length === 4) {
          // 🚀 Formamos el HTML matemáticamente y aseguramos que el PDF se quede en el guid
          webDefinitiva = `https://doe.juntaex.es/otrosFormatos/html.php?xml=20${matchDoe[3]}&anio=${matchDoe[1]}&doe=${matchDoe[2]}`;
          pdfDefinitivo = enlaceBaseDoe; 
      }
  }

  // BOIB (Baleares): Si la IA secundaria encontró el PDF dentro de la página, aseguramos que sea absoluto
  if (fuente.nombre === "BOIB" && pdfDefinitivo && pdfDefinitivo.includes('/eboibfront/pdf/')) {
      const matchPdf = pdfDefinitivo.match(/\/eboibfront\/pdf\/.+/);
      if (matchPdf) {
          pdfDefinitivo = "https://www.caib.es" + matchPdf[0];
      }
  }

  // BON (Navarra): Forzamos a que el enlace PDF (guid) sea exactamente igual al HTML (link_boe)
  if (fuente.nombre === "BON") {
      pdfDefinitivo = webDefinitiva;
  }


  // Fallback de seguridad (BON y demás aplicarán aquí y tendrán links idénticos si no hay PDF extraído)
  if (!pdfDefinitivo) pdfDefinitivo = webDefinitiva;
  if (!webDefinitiva) webDefinitiva = pdfDefinitivo;
  // ----------------------------------------------------------

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
    categoria: analisisIA.categoria,
    turno: analisisIA.turno,
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

module.exports = {
  supabase,
  gestionarDepartamento,
  procesarYGuardarConvocatoria
};
