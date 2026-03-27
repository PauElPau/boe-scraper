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

            // 1. BOPV (País Vasco): Reemplazar extensión y el subdominio 'y22' por 'web01'
            if (fuente.nombre === "BOPV" && item.link) {
                item.link = item.link.replace('/y22-bopv/', '/web01-bopv/');
                if (item.link.endsWith('.shtml')) {
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
                const numMatch = item.title.match(/^\s*(\d+)/); // Busca números al inicio del título
                
                if (idMatch && numMatch) {
                    const idDoc = idMatch[1];
                    const numDoc = numMatch[1];
                    
                    const dateObj = new Date(item.isoDate || item.pubDate || new Date());
                    const yyyy = dateObj.getFullYear();
                    const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
                    const dd = String(dateObj.getDate()).padStart(2, '0');
                    
                    item.link = `https://www.borm.es/#/home/anuncio/${dd}-${mm}-${yyyy}/${numDoc}`;
                    enlacePdfRss = `https://www.borm.es/services/anuncio/ano/${yyyy}/numero/${numDoc}/pdf?id=${idDoc}`;
                } else {
                    item.link = item.guid;
                    enlacePdfRss = item.guid;
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

          if (fuente.rssToHtml) {
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

            // 🛠️ INTERCEPTOR DOGV: Reconstruimos la URL larga con el ID
            if (fuente.nombre === "DOGV" && (enlaceLimpio.includes('id_emp') || enlaceLimpio.includes('id%5Femp'))) {
                const matchId = enlaceLimpio.match(/id(?:_|%5F)emp=(\d+)/i);
                if (matchId && matchId[1]) {
                    // Creamos la URL del PDF dinámicamente según la estructura de Liferay
                    item.pdfGenerado = `https://sede.gva.es/es/detall-ocupacio-publica?p_p_id=es_gva_es_siac_portlet_SiacDetalleEmpleoPublicoNuevoGVA&p_p_lifecycle=2&p_p_state=normal&p_p_mode=view&p_p_cacheability=cacheLevelPage&_es_gva_es_siac_portlet_SiacDetalleEmpleoPublicoNuevoGVA_accion=pdf&_es_gva_es_siac_portlet_SiacDetalleEmpleoPublicoNuevoGVA_codigo=${matchId[1]}`;
                    enlaceLimpio = `https://sede.gva.es/detall-ocupacio-publica?id_emp=${matchId[1]}`;
                }
            }

            // 🛠️ INTERCEPTOR DOCM (Castilla-La Mancha): Limpiar el punto /./ y generar HTML
            if (fuente.nombre === "DOCM") {
                let pdfLimpio = enlaceLimpio.replace('/./', '/docm/'); // Limpia el error nativo de su web
                item.pdfGenerado = pdfLimpio;
                if (pdfLimpio.includes('descargarArchivo.do') && pdfLimpio.includes('/pdf/')) {
                    item.htmlGenerado = pdfLimpio.replace('descargarArchivo.do', 'verArchivoHtml.do')
                                                 .replace('/pdf/', '/html/')
                                                 .replace('.pdf', '.html');
                }
            }
            // 🛠️ INTERCEPTOR BOCYL (Castilla y León): Tres reemplazos en la cadena
            if (fuente.nombre === "BOCYL" && enlaceLimpio.includes('/pdf/')) {
                item.htmlGenerado = enlaceLimpio.replace('/boletines/', '/html/')
                                                .replace('/pdf/', '/html/')
                                                .replace('.pdf', '.do');
            }

            // 🛠️ INTERCEPTOR BOPA (ASTURIAS): Mantenemos el HTML "feo" y extraemos el PDF limpio
            if (fuente.nombre === "BOPA" && enlaceLimpio.includes('dispositionText') && enlaceLimpio.includes('dispositionDate')) {
                const matchId = enlaceLimpio.match(/dispositionText=([^&]+)/);
                const matchDate = enlaceLimpio.match(/dispositionDate=([^&]+)/);
                if (matchId && matchDate) {
                    const idDoc = matchId[1];
                    const decodedDate = decodeURIComponent(matchDate[1]); 
                    const partesFecha = decodedDate.split('/'); // [DD, MM, YYYY]
                    if (partesFecha.length === 3) {
                        // Solo asignamos el PDF, el enlaceLimpio sigue intacto como HTML feo
                        item.pdfGenerado = `https://sede.asturias.es/bopa/${partesFecha[2]}/${partesFecha[1]}/${partesFecha[0]}/${idDoc}.pdf`;
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
