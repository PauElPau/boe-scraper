require("../config/env");

const Parser = require("rss-parser");
const { FUENTES_BOLETINES } = require("../config/sources");
const { esperar, esTramiteBasura } = require("../utils/helpers");
const { obtenerTextoNativo, obtenerTextoUniversal, obtenerDOGCporAPI, obtenerCantabriaMatematico, extraerTextoDePDF } = require("../services/scraper");
const { extraerEnlacesSumarioIA, getIaDetenida } = require("../services/ai");
const { procesarYGuardarConvocatoria, gestionarDepartamento } = require("../services/db");
const { enviarAlertasPorEmail, enviarAlertasFavoritos, enviarAlertaTelegram, enviarReporteAdmin } = require("../services/notifications");
const { obtenerUrlDelDia } = require('../services/preScrapers'); 

const parser = new Parser({
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  },
});

async function extraerBoletines() {
  const startTime = Date.now(); 
  let totalErrores = 0; 
  const reporteStats = {};

  try {
    const convocatoriasInsertadasHoy = [];

    for (const fuente of FUENTES_BOLETINES) {
      if (getIaDetenida()) break; 

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

          statsFuente.encontradas = listadoValidoRss.length;

          for (const item of listadoValidoRss) {
            if (getIaDetenida()) break; 

            const categoriaSeccion = item.categories?.[0] || `Boletín ${fuente.nombre}`;
            const categoriaOrganismo = item.categories?.[1] || fuente.ambito;

            let enlacePdfRss = item.enclosure?.url || null;
            if (!enlacePdfRss && item.guid && item.guid.toLowerCase().includes('.pdf')) enlacePdfRss = item.guid;

            if (fuente.nombre === "BOPV" && item.link) {
                item.link = item.link.replace('/y22-bopv/', '/web01-bopv/');
                if (item.link.endsWith('.shtml')) {
                    enlacePdfRss = item.link.replace('.shtml', '.pdf');
                }
            }

            if (fuente.nombre === "DOG" && item.link && item.link.endsWith('.html')) {
                enlacePdfRss = item.link.replace('.html', '.pdf');
            }

            if (fuente.nombre === "BOA" && item.link && item.link.includes('DOCN=')) {
                if (item.link.startsWith('/cgi-bin')) item.link = "https://www.boa.aragon.es" + item.link;
                enlacePdfRss = null; 
            }

            if (fuente.nombre === "BORM" && item.guid && item.guid.includes('/pdf')) {
                const idMatch = item.guid.match(/\/anuncio\/(\d+)\/pdf/);
                const numMatch = item.title.match(/^\s*(\d+)/);
                
                if (idMatch && numMatch) {
                    const idDoc = idMatch[1];
                    const numDoc = numMatch[1];
                    
                    const hoyBorm = new Date();
                    const yyyyBorm = hoyBorm.getFullYear();
                    const mmBorm = String(hoyBorm.getMonth() + 1).padStart(2, '0');
                    const ddBorm = String(hoyBorm.getDate()).padStart(2, '0');
                    
                    item.link = `https://www.borm.es/#/home/anuncio/${ddBorm}-${mmBorm}-${yyyyBorm}/${numDoc}`;
                    enlacePdfRss = `https://www.borm.es/services/anuncio/ano/${yyyyBorm}/numero/${numDoc}/pdf?id=${idDoc}`;
                }
            }

            console.log(`\n📄 Extrayendo interior de: ${item.tituloLimpioParaLog.substring(0,70)}...\n   🔗 ${item.link}`);
            
            let textoParaIA = null;
            let pdfExtraidoNativo = item.pdf || null;

            if (["BOE", "BOJA", "BOPV", "BORM", "DOE", "DOG", "BOCM", "BOA", "BOC"].includes(fuente.nombre)) {
              const nativo = await obtenerTextoNativo(item.link);
              textoParaIA = nativo ? nativo.texto : null;
              pdfExtraidoNativo = nativo ? nativo.pdf : null;
            } else if (item.link.toLowerCase().includes('pdf')) {
              textoParaIA = item.tituloLimpioParaLog + " - " + (item.contentSnippet || item.content || "");
            } else {
              textoParaIA = await obtenerTextoUniversal(item.link);
            }
            
            if (!textoParaIA || textoParaIA.length < 50) textoParaIA = item.contentSnippet || item.content;
            if (textoParaIA && textoParaIA.length > 25000) textoParaIA = textoParaIA.substring(0, 25000) + "... [Texto cortado]";

            await procesarYGuardarConvocatoria({ 
              title: item.tituloLimpioParaLog, link: item.link, guid: item.guid, link_boletin: urlFinalLog,
              pdf_rss: enlacePdfRss || pdfExtraidoNativo, section: categoriaSeccion, department: categoriaOrganismo 
            }, textoParaIA, fuente, convocatoriasInsertadasHoy, statsFuente);
            
            await esperar(6000);
          }
        } 
        
        else if (fuente.tipo === "html_directo") {
          let urlFinal = urlFinalLog; 

          if (fuente.fase_previa) {
              urlFinal = await obtenerUrlDelDia(fuente);
              if (!urlFinal) {
                  console.log(`   ⏭️ La portada de ${fuente.nombre} no contiene boletín para hoy.`);
                  continue; 
              }
              if (urlFinal !== "API_REST") console.log(`   🎯 URL real del día localizada: ${urlFinal}`);
          }

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

         let listadoBruto = [];

          // 🚀 AUTOPISTA MATEMÁTICA PARA CANTABRIA
            if (fuente.nombre === "BOC_CANTABRIA") {
                let apiResults = await obtenerCantabriaMatematico();
                if (apiResults && apiResults.length > 0) {
                    listadoBruto = apiResults;
                } else {
                    console.log(`   ⏭️ La extracción directa de ${fuente.nombre} no devolvió resultados para hoy.`);
                    continue;
                }
            }
          // 🐢 CAMINO TRADICIONAL PARA EL RESTO (¡AHORA INCLUYE EL DOGC!)
          else {
              let markdownWeb = null;
              if (fuente.nombre === "BOA") {
                  const res = await fetch(urlFinal);
                  markdownWeb = await res.text();
              // 🐛 Añadimos DOGC aquí para que use el Proxy rápido y esquive Cloudflare
              } else if (["BOPA", "BON", "DOCM", "BOCYL", "BOCCE", "BOME"].includes(fuente.nombre)) {
                  const nativo = await obtenerTextoNativo(urlFinal, true);
                  markdownWeb = nativo ? nativo.texto : null;
              } else {
                  markdownWeb = await obtenerTextoUniversal(urlFinal);
              }
              
              if (!markdownWeb) {
                  console.log(`   ⚠️ No se pudo extraer el HTML de la portada de ${fuente.nombre}`);
                  continue;
              }

              if (markdownWeb.length > 80000) markdownWeb = markdownWeb.substring(0, 80000); 
              if (fuente.nombre === "BOIB") markdownWeb = markdownWeb.replace(/\[[^\]]*\]\([^)]*\/pdf\/[^)]*\)/gi, '');

              console.log(`🤖 Buscando enlaces de empleo en el sumario de ${fuente.nombre}...`);
              listadoBruto = await extraerEnlacesSumarioIA(markdownWeb, fuente.nombre);
          }
          
          let listado = listadoBruto.filter((item, index, self) =>
              index === self.findIndex((t) => t.enlace === item.enlace)
          );

          // 🧪 PARCHE DE PRUEBAS: Limitar DOGC a solo 2 convocatorias
          if (fuente.nombre === "DOGC") {
              listado = listado.slice(0, 2);
              console.log(`   🧪 MODO PRUEBA: Limitando DOGC a solo ${listado.length} convocatorias.`);
          }

          console.log(`✅ Encontradas ${listado.length} posibles convocatorias únicas.`);
          statsFuente.encontradas = listado.length;

          for (const item of listado) {
            if (getIaDetenida()) break; 
            
            // 🐛 1. REPARAMOS LA URL DE INMEDIATO (Antes de cualquier check)
            let enlaceLimpio = item.enlace.replace(/[>)"'\]]/g, '').trim();
            
            if (fuente.nombre === "DOGC") {
                const docIdMatch = enlaceLimpio.match(/documentId=(\d+)/);
                if (docIdMatch) {
                    enlaceLimpio = `https://dogc.gencat.cat/es/document-del-dogc/?documentId=${docIdMatch[1]}`;
                }
            }
            // Asignamos el enlace arreglado al item para que todo el sistema lo use bien
            item.enlace = enlaceLimpio; 

            // 2. AHORA SÍ, HACEMOS LOS CHECKS Y BARRIDOS
            const t = item.titulo.toLowerCase();
            
            if (t.includes('carta de servicios') || t.includes('pago de anuncios') || t.includes('publicar en') || esTramiteBasura(item.titulo)) {
                console.log(`   🧹 Barrido por el Topo (Regex): ${item.titulo.substring(0,60)}...\n      🔗 ${item.enlace}`);
                continue;
            }

            if (fuente.nombre === "BOIB") {
                let idx = enlaceLimpio.lastIndexOf('eboibfront');
                if (idx !== -1) {
                    enlaceLimpio = "https://www.caib.es/" + enlaceLimpio.substring(idx);
                    item.htmlGenerado = enlaceLimpio;
                    item.pdfGenerado = null; 
                }
            }

            if (fuente.nombre === "DOGV" && (enlaceLimpio.includes('id_emp') || enlaceLimpio.includes('id%5Femp'))) {
                const matchId = enlaceLimpio.match(/id(?:_|%5F)emp=(\d+)/i);
                if (matchId && matchId[1]) {
                    item.pdfGenerado = `https://sede.gva.es/es/detall-ocupacio-publica?p_p_id=es_gva_es_siac_portlet_SiacDetalleEmpleoPublicoNuevoGVA&p_p_lifecycle=2&p_p_state=normal&p_p_mode=view&p_p_cacheability=cacheLevelPage&_es_gva_es_siac_portlet_SiacDetalleEmpleoPublicoNuevoGVA_accion=pdf&_es_gva_es_siac_portlet_SiacDetalleEmpleoPublicoNuevoGVA_codigo=${matchId[1]}`;
                    enlaceLimpio = `https://sede.gva.es/detall-ocupacio-publica?id_emp=${matchId[1]}`;
                }
            }

            if (fuente.nombre === "DOCM") {
                let pathLimpio = enlaceLimpio.replace('https://docm.jccm.es', '').replace(/^\/+/, '').replace(/^\.\//, '').replace(/^docm\//, '');
                item.pdfGenerado = "https://docm.jccm.es/docm/" + pathLimpio;
                
                if (pathLimpio.includes('descargarArchivo.do') && pathLimpio.includes('/pdf/')) {
                    item.htmlGenerado = "https://docm.jccm.es/docm/" + pathLimpio.replace('descargarArchivo.do', 'verArchivoHtml.do')
                                                                                 .replace('/pdf/', '/html/')
                                                                                 .replace('.pdf', '.html');
                }
            }

            if (fuente.nombre === "BOCYL" && enlaceLimpio.includes('/pdf/')) {
                item.pdfGenerado = enlaceLimpio; 
                item.htmlGenerado = enlaceLimpio.replace('/boletines/', '/html/')
                                                .replace('/pdf/', '/html/')
                                                .replace('.pdf', '.do');
            }

            if (fuente.nombre === "BOPA" && enlaceLimpio.includes('dispositionText') && enlaceLimpio.includes('dispositionDate')) {
                const matchId = enlaceLimpio.match(/dispositionText=([^&]+)/);
                const matchDate = enlaceLimpio.match(/dispositionDate=([^&]+)/);
                if (matchId && matchDate) {
                    const idDoc = matchId[1];
                    const decodedDate = decodeURIComponent(matchDate[1]); 
                    const partesFecha = decodedDate.split('/'); 
                    if (partesFecha.length === 3) {
                        item.pdfGenerado = `https://miprincipado.asturias.es/bopa/${partesFecha[2]}/${partesFecha[1]}/${partesFecha[0]}/${idDoc}.pdf`;
                        item.htmlGenerado = `https://miprincipado.asturias.es/bopa/disposiciones?p_p_id=pa_sede_bopa_web_portlet_SedeBopaDispositionWeb&p_p_lifecycle=0&_pa_sede_bopa_web_portlet_SedeBopaDispositionWeb_mvcRenderCommandName=%2Fdisposition%2Fdetail&p_r_p_dispositionText=${idDoc}&p_r_p_dispositionReference=${idDoc}&p_r_p_dispositionDate=${partesFecha[0]}%2F${partesFecha[1]}%2F${partesFecha[2]}`;
                    }
                }
            }

            if (fuente.nombre === "DOGC") {
                // Sacamos el ID del documento
                const docIdMatch = enlaceLimpio.match(/documentId=(\d+)/);
                if (docIdMatch && fuente.numDOGC_calculado) {
                    const docId = docIdMatch[1];
                    // Fabricamos el enlace directo e infalible al PDF de la Generalitat
                    item.pdfGenerado = `https://portaldogc.gencat.cat/utilsEADOP/PDF/${fuente.numDOGC_calculado}/${docId}.pdf`;
                }
                item.htmlGenerado = enlaceLimpio;
            }
            
            // Ignoramos anclas internas, pero perdonamos al DOGC que suele llevar sumari-del-dogc
            if (enlaceLimpio.includes('#section') || (enlaceLimpio.includes('sumari-del-dogc') && fuente.nombre !== "DOGC") || enlaceLimpio.startsWith('#')) {
                console.log(`   ⏭️ Ignorado: El enlace es un salto interno de la web -> ${enlaceLimpio}`);
                continue;
            }

           let enlaceFinal = enlaceLimpio;
            
            try {
                if (!enlaceFinal.startsWith('http')) {
                    const urlBaseObj = new URL(urlFinal); 
                    if (enlaceFinal.startsWith('/')) {
                        enlaceFinal = urlBaseObj.origin + enlaceFinal;
                    } else {
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
            
            // ===================================================================================
            // 🚀 BLOQUE DE RUTA ESTRICTA Y RAYOS X
            // ===================================================================================
            // 🐛 AÑADIDO: Si la fuente es DOGC, forzamos a que descargue y lea su PDF oficial directamente
            let forzarPdfDOGC = fuente.nombre === "DOGC" && (pdfExtraidoNativo || item.pdf_extraido || item.pdfGenerado);
            let esPdfOculto = enlaceFinal.toLowerCase().includes('.pdf') || enlaceFinal.includes('jdownloads') || fuente.nombre === "BOPA" || fuente.nombre === "BOC_CANTABRIA" || forzarPdfDOGC;

            if (esPdfOculto) {
                console.log(`   📄 Enlace (PDF o DOGC) detectado. Activando visión de Rayos X...`);
                
                // Si es DOGC, usamos el enlace directo al PDF que nos dio la API. Si no, usamos enlaceFinal.
                let urlParaRayosX = forzarPdfDOGC ? (pdfExtraidoNativo || item.pdf_extraido || item.pdfGenerado || enlaceFinal) : enlaceFinal;
                if (!urlParaRayosX.startsWith('http')) urlParaRayosX = 'https://' + urlParaRayosX.replace(/^\/\//, '');

                const textoPdf = await extraerTextoDePDF(urlParaRayosX);

                if (textoPdf && textoPdf.length > 50) {
                    textoInterior = textoPdf;
                    console.log(`   ✅ PDF leído correctamente con Rayos X (${textoInterior.length} caracteres).`);
                } else {
                    console.log(`   ⚠️ El PDF era una imagen escaneada o está protegido. Usando texto de respaldo.`);
                    textoInterior = `${item.titulo}\n\n[Documento oficial en formato PDF. Accede al enlace superior para leer las bases completas.]`;
                }
                pdfExtraidoNativo = urlParaRayosX;

            } else if (["BON", "BOCCE", "BOME"].includes(fuente.nombre)) {
                const nativo = await obtenerTextoNativo(enlaceFinal, true); 
                textoInterior = nativo ? nativo.texto : null;
                if (nativo && nativo.pdf) pdfExtraidoNativo = nativo.pdf;
            } else if (["BOA", "BOCYL", "DOCM", "DOGV"].includes(fuente.nombre)) {
                const nativo = await obtenerTextoNativo(enlaceFinal);
                textoInterior = nativo ? nativo.texto : null;
                if (nativo && nativo.pdf) pdfExtraidoNativo = nativo.pdf;
            } else {
                textoInterior = await obtenerTextoUniversal(enlaceFinal);
            }

            if (!textoInterior) continue;
            
            if (textoInterior.length > 25000) textoInterior = textoInterior.substring(0, 25000) + "... [Texto cortado]";

            await procesarYGuardarConvocatoria({ 
              title: item.titulo, 
              link: enlaceFinal, 
              guid: enlaceFinal, 
              link_boletin: urlFinal,
              pdf_extraido: pdfExtraidoNativo, 
              htmlGenerado: item.htmlGenerado, 
              pdfGenerado: item.pdfGenerado,   
              section: `Boletín ${fuente.nombre}`, 
              department: item.departamento 
            }, textoInterior, fuente, convocatoriasInsertadasHoy, statsFuente);
            
            await esperar(6000);
          }
        }
      } catch (err) {
        console.error(`❌ Error procesando ${fuente.nombre}:`, err.message);
        statsFuente.errores++; 
        totalErrores++;
      }
    }

    console.log(`\n🎉 RASTREO COMPLETADO. Total nuevas insertadas: ${convocatoriasInsertadasHoy.length}`);
    
    let alertasEmail = 0;
    let alertasFavs = 0;

    if (convocatoriasInsertadasHoy.length > 0) {
        alertasEmail = await enviarAlertasPorEmail(convocatoriasInsertadasHoy) || 0;
        alertasFavs = await enviarAlertasFavoritos(convocatoriasInsertadasHoy) || 0;
        await enviarAlertaTelegram(convocatoriasInsertadasHoy);
    }


    try {
        if (process.env.VERCEL_WEBHOOK && convocatoriasInsertadasHoy.length > 0) {
            await fetch(process.env.VERCEL_WEBHOOK, { method: 'POST' });
        }
    } catch (e) {
        console.error("⚠️ Fallo al avisar al webhook de Vercel (Revalidación ISR):", e.message);
    }


    // Ahora el reporte de Telegram está a salvo y siempre se enviará
    const durationMinutes = ((Date.now() - startTime) / 60000).toFixed(2);
    await enviarReporteAdmin(reporteStats, alertasEmail, alertasFavs, totalErrores, durationMinutes);

  } catch (error) {
    console.error("🔥 Error crítico general:", error);
  }
}

module.exports = {
  extraerBoletines
};