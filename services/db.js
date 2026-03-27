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

  
  // --- 🛠️ ASIGNACIÓN DEFINITIVA DE ENLACES (link_boe y guid) ---
  
  // 1. Asignamos el HTML principal (link_boe)
  let webDefinitiva = itemData.htmlGenerado || itemData.link;
  
  // 2. Asignamos el PDF principal (guid)
  let pdfDefinitivo = itemData.pdfGenerado || analisisIA.enlace_pdf || itemData.pdf_rss || itemData.pdf_extraido;

  // 3. REGLAS DE SEGURIDAD Y LIMPIEZA
  
  // Si la web definitiva sigue teniendo llaves (plantillas rotas), usamos la portada del boletín
  if (webDefinitiva.includes('{')) {
      webDefinitiva = itemData.link_boletin;
  }

  // DOE (Extremadura): Reconstruir HTML desde el PDF (si lo tenemos)
  if (fuente.nombre === "DOE" && pdfDefinitivo && pdfDefinitivo.includes('.pdf') && webDefinitiva.includes('rss.php')) {
      const matchDoe = pdfDefinitivo.match(/\/doe\/\d{4}\/([^/]+)\/(\d+)\.pdf/);
      if (matchDoe && matchDoe.length === 3) {
          const anio = new Date().getFullYear();
          webDefinitiva = `https://doe.juntaex.es/otrosFormatos/html.php?xml=${matchDoe[2]}&anio=${anio}&doe=${matchDoe[1]}`;
      }
  }

  // BOIB (Baleares): Forzamos a que el enlace web sea también el PDF directo
  if (fuente.nombre === "BOIB" && pdfDefinitivo && pdfDefinitivo.includes('.pdf')) {
      webDefinitiva = pdfDefinitivo;
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
