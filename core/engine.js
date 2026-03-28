require("../config/env");

const Parser = require("rss-parser");
const { FUENTES_BOLETINES } = require("../config/sources");
const { esperar, esTramiteBasura } = require("../utils/helpers");
const { obtenerTextoNativo, obtenerTextoUniversal } = require("../services/scraper");
const { extraerEnlacesSumarioIA, getIaDetenida } = require("../services/ai");
const { procesarYGuardarConvocatoria, gestionarDepartamento } = require("../services/db");
const { enviarAlertasPorEmail, enviarAlertasFavoritos, enviarAlertaTelegram, enviarReporteAdmin } = require("../services/notifications");

const parser = new Parser({
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  },
});

// --- 8. BUCLE PRINCIPAL ---
async function extraerBoletines() {
  const startTime = Date.now(); 
  let totalErrores = 0; 
  const reporteStats = {};

  try {
    const convocatoriasInsertadasHoy = [];

    for (const fuente of FUENTES_BOLETINES) {
      if (getIaDetenida()) break; 

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
            if (getIaDetenida()) break; 

            const categoriaSeccion = item.categories?.[0] || `Boletín ${fuente.nombre}`;
            const categoriaOrganismo = item.categories?.[1] || fuente.ambito;

            // --- 🛠️ EXTRACCIÓN Y LIMPIEZA DE PDFS PARA RSS ---
            let enlacePdfRss = item.enclosure?.url || null;
            if (!enlacePdfRss && item.guid && item.guid.toLowerCase().includes('.pdf')) enlacePdfRss = item.guid;

            // 1. BOPV (País Vasco): Asegurar ruta completa absoluta
            if (fuente.nombre === "BOPV" && item.link) {
                item.link = item.link.replace('/y22-bopv/', '/web01-bopv/');
                if (item.link.endsWith('.shtml')) {
                    // Forzamos la asignación ignorando cualquier ruta relativa basura del enclosure
                    enlacePdfRss = item.link.replace('.shtml', '.pdf'); 
                }
            }
            if (fuente.nombre === "BOJA" && item.link && item.link.endsWith('.html')) {
                // A BOJA no le podemos adivinar el PDF exacto sin descargar la web
                // Lo dejamos nulo para que la IA (o el fallback posterior) lo extraiga si puede,
                // o que simplemente guarde el HTML en el campo GUID para no guardar rutas relativas rotas.
                enlacePdfRss = null; 
            }

            // 2. DOG (Galicia): Transformación directa de HTML a PDF
            if (fuente.nombre === "DOG" && item.link && item.link.endsWith('.html')) {
                enlacePdfRss = item.link.replace('.html', '.pdf');
            }

            // 3. BOA (Aragón): Cambiar VERDOC por VERPDF
            if (fuente.nombre === "BOA" && item.link && item.link.includes('DOCN=')) {
                if (item.link.startsWith('/cgi-bin')) item.link = "https://www.boa.aragon.es" + item.link;
                enlacePdfRss = item.link.replace('CMD=VERDOC', 'CMD=VERPDF');
            }

            // 4. BORM (Murcia): Magia para extraer el nº de boletín del título e ID del guid
            if (fuente.nombre === "BORM" && item.guid && item.guid.includes('/pdf')) {
                const idMatch = item.guid.match(/\/anuncio\/(\d+)\/pdf/);
                const numMatch = item.title.match(/^\s*(\d+)/);
                
                if (idMatch && numMatch) {
                    const idDoc = idMatch[1];
                    const numDoc = numMatch[1];
                    
                    // 🚀 PARCHE BORM: Usar siempre la fecha actual para la ruta
                    const hoyBorm = new Date();
                    const yyyyBorm = hoyBorm.getFullYear();
                    const mmBorm = String(hoyBorm.getMonth() + 1).padStart(2, '0');
                    const ddBorm = String(hoyBorm.getDate()).padStart(2, '0');
                    
                    item.link = `https://www.borm.es/#/home/anuncio/${ddBorm}-${mmBorm}-${yyyyBorm}/${numDoc}`;
                    enlacePdfRss = `https://www.borm.es/services/anuncio/ano/${yyyyBorm}/numero/${numDoc}/pdf?id=${idDoc}`;
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

          // 🛠️ INTERCEPTOR BOIB: Leer RSS, buscar el de hoy y construir URL de la sección
          if (fuente.boibRssToHtml) {
              console.log(`   🔗 Extrayendo URL del BOIB de hoy desde su RSS...`);
              try {
                  const resRss = await fetch(urlFinal);
                  const xmlRss = await resRss.text();
                  const feed = await parser.parseString(xmlRss);
                  
                  const hoyFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
                  
                  const itemDeHoy = feed.items.find(item => {
                      if (!item.isoDate && !item.pubDate) return false;
                      const itemDate = new Date(item.isoDate || item.pubDate);
                      const itemFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(itemDate);
                      return itemFormat === hoyFormat;
                  });

                  if (itemDeHoy && itemDeHoy.link) {
                      // 🚀 AQUÍ ESTÁ LA MAGIA: Concatenar la sección exacta
                      urlFinal = itemDeHoy.link + "/seccion-ii-autoridades-y-personal/473"; 
                      console.log(`   ✅ Boletín BOIB de hoy localizado: ${urlFinal}`);
                  } else {
                      console.log(`   ⏭️ No hay boletín BOIB publicado con fecha de hoy (${hoyFormat}).`);
                      continue; 
                  }
              } catch (e) {
                  console.error(`   ❌ Error leyendo el RSS puente del BOIB: ${e.message}`);
                  totalErrores++;
                  continue;
              }
          } 
          // Mantenemos el antiguo por si alguna otra fuente futura lo necesita
          else if (fuente.rssToHtml) {
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
            if (getIaDetenida()) break; 
            const t = item.titulo.toLowerCase();
            
            if (t.includes('carta de servicios') || t.includes('pago de anuncios') || t.includes('publicar en') || esTramiteBasura(item.titulo)) {
                console.log(`   🧹 Barrido por el Topo (Regex): ${item.titulo.substring(0,60)}...\n      🔗 ${item.enlace}`);
                continue;
            }

            let enlaceLimpio = item.enlace.replace(/[>)"'\]]/g, '').trim();

            // 🛠️ INTERCEPTOR BOIB (Baleares): Arreglar la ruta relativa y generar HTML/PDF
            if (fuente.nombre === "BOIB") {
                // 1. Limpiamos la ruta relativa monstruosa si se ha concatenado mal
                // A veces la IA devuelve "/eboibfront/pdf/es/..." o "https://.../473/eboibfront/pdf/..."
                let rutaSucia = enlaceLimpio;
                if (rutaSucia.includes('/eboibfront/pdf/')) {
                    const matchPdf = rutaSucia.match(/\/eboibfront\/pdf\/.+/);
                    if (matchPdf) {
                        // Construimos el PDF real absoluto
                        item.pdfGenerado = "https://www.caib.es" + matchPdf[0];
                        // Construimos el HTML real cambiando /pdf/ por /html/
                        item.htmlGenerado = item.pdfGenerado.replace('/eboibfront/pdf/', '/eboibfront/html/');
                        // Le decimos al código que use el HTML como enlace web para la BD
                        enlaceLimpio = item.htmlGenerado;
                    }
                } 
                // En caso de que la IA extraiga el enlace HTML en vez del PDF
                else if (rutaSucia.includes('/eboibfront/html/')) {
                    const matchHtml = rutaSucia.match(/\/eboibfront\/html\/.+/);
                    if (matchHtml) {
                        item.htmlGenerado = "https://www.caib.es" + matchHtml[0];
                        item.pdfGenerado = item.htmlGenerado.replace('/eboibfront/html/', '/eboibfront/pdf/');
                        enlaceLimpio = item.htmlGenerado;
                    }
                }
                // En caso de que la IA extraiga el enlace "bonito" con el número largo
                // (ej: https://www.caib.es/eboibfront/es/2026/12251/713647/bases-del-concurso...)
                else if (rutaSucia.match(/\/es\/\d{4}\/\d+\/\d+\//)) {
                    // Si nos da este enlace, lo usamos como HTML, 
                    // pero no podemos adivinar el PDF exacto (lo dejamos null para que lo busque el PDF nativo)
                    item.htmlGenerado = rutaSucia.startsWith('http') ? rutaSucia : "https://www.caib.es" + rutaSucia;
                    enlaceLimpio = item.htmlGenerado;
                }
            }

            // 🛠️ INTERCEPTOR DOGV: Reconstruimos la URL larga con el ID
            if (fuente.nombre === "DOGV" && (enlaceLimpio.includes('id_emp') || enlaceLimpio.includes('id%5Femp'))) {
                const matchId = enlaceLimpio.match(/id(?:_|%5F)emp=(\d+)/i);
                if (matchId && matchId[1]) {
                    // Creamos la URL del PDF dinámicamente según la estructura de Liferay
                    item.pdfGenerado = `https://sede.gva.es/es/detall-ocupacio-publica?p_p_id=es_gva_es_siac_portlet_SiacDetalleEmpleoPublicoNuevoGVA&p_p_lifecycle=2&p_p_state=normal&p_p_mode=view&p_p_cacheability=cacheLevelPage&_es_gva_es_siac_portlet_SiacDetalleEmpleoPublicoNuevoGVA_accion=pdf&_es_gva_es_siac_portlet_SiacDetalleEmpleoPublicoNuevoGVA_codigo=${matchId[1]}`;
                    enlaceLimpio = `https://sede.gva.es/detall-ocupacio-publica?id_emp=${matchId[1]}`;
                }
            }

            // 🛠️ INTERCEPTOR DOCM (Castilla-La Mancha)
            if (fuente.nombre === "DOCM") {
                // Elimina el '/./' y deja el PDF limpio
                let pdfLimpio = enlaceLimpio.replace('/./', '/'); 
                item.pdfGenerado = pdfLimpio;
                if (pdfLimpio.includes('descargarArchivo.do') && pdfLimpio.includes('/pdf/')) {
                    // Genera el HTML inyectando 'docm/' y cambiando pdf por html
                    item.htmlGenerado = pdfLimpio.replace('descargarArchivo.do', 'docm/verArchivoHtml.do')
                                                 .replace('/pdf/', '/html/')
                                                 .replace('.pdf', '.html');
                }
            }

            // 🛠️ INTERCEPTOR BOCYL (Castilla y León)
            if (fuente.nombre === "BOCYL" && enlaceLimpio.includes('/pdf/')) {
                // El enlace que capturamos es el PDF, lo guardamos
                item.pdfGenerado = enlaceLimpio; 
                // Generamos el HTML cambiando 'boletines' por 'html', y '.pdf' por '.do'
                item.htmlGenerado = enlaceLimpio.replace('/boletines/', '/html/')
                                                .replace('/pdf/', '/html/')
                                                .replace('.pdf', '.do');
            }

            // 🛠️ INTERCEPTOR BOPA (ASTURIAS)
            if (fuente.nombre === "BOPA" && enlaceLimpio.includes('dispositionText') && enlaceLimpio.includes('dispositionDate')) {
                const matchId = enlaceLimpio.match(/dispositionText=([^&]+)/);
                const matchDate = enlaceLimpio.match(/dispositionDate=([^&]+)/);
                if (matchId && matchDate) {
                    const idDoc = matchId[1];
                    const decodedDate = decodeURIComponent(matchDate[1]); 
                    const partesFecha = decodedDate.split('/'); // [DD, MM, YYYY]
                    if (partesFecha.length === 3) {
                        // PDF Limpio
                        item.pdfGenerado = `https://miprincipado.asturias.es/bopa/${partesFecha[2]}/${partesFecha[1]}/${partesFecha[0]}/${idDoc}.pdf`;
                        // HTML Feo reconstruido matemáticamente
                        item.htmlGenerado = `https://miprincipado.asturias.es/bopa/disposiciones?p_p_id=pa_sede_bopa_web_portlet_SedeBopaDispositionWeb&p_p_lifecycle=0&_pa_sede_bopa_web_portlet_SedeBopaDispositionWeb_mvcRenderCommandName=%2Fdisposition%2Fdetail&p_r_p_dispositionText=${idDoc}&p_r_p_dispositionReference=${idDoc}&p_r_p_dispositionDate=${partesFecha[0]}%2F${partesFecha[1]}%2F${partesFecha[2]}`;
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

module.exports = {
  extraerBoletines
};
