const cheerio = require("cheerio");
const pdfParse = require('pdf-parse'); // 🐛 TIENE QUE ESTAR AQUÍ ARRIBA
const https = require('https');

const { esperar } = require("../utils/helpers");


// 🛡️ MEJORA: Escudo Anti-Geobloqueo, Atajo Directo y Preservación de Enlaces
async function obtenerTextoNativo(url, forzarCodeTabs = false) {
  let html = "";
  let exito = false;
  
  // 1. Intento CodeTabs (Si está forzado o como primera opción rápida)
  if (forzarCodeTabs) {
    console.log(`   🚀 Atajo activado: Saltando barreras y yendo directo al Plan D (CodeTabs)...`);
    try {
      const proxyUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`;
      const resProxy = await fetch(proxyUrl);
      if (resProxy.ok) {
          html = await resProxy.text();
          exito = true;
      } else {
          console.log(`   ⚠️ CodeTabs falló (Status ${resProxy.status}). Cayendo a cascada secundaria...`);
      }
    } catch (e) {
      console.log(`   ⚠️ Error de red en CodeTabs. Cayendo a cascada secundaria...`);
    }
  }

  // 2. Cascada Secundaria (Si no era CodeTabs o si CodeTabs falló)
  if (!exito) {
    try {
      const respuesta = await fetch(url, {
          headers: { 
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
              "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "es-ES,es;q=0.9"
          }
      });
      if (!respuesta.ok) throw new Error("Nativo bloqueado");
      html = await respuesta.text();
    } catch (error) {
      console.log(`   ⚠️ Fallo de red detectado (Posible geobloqueo). Activando Proxy Público...`);
      try {
        const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
        const resProxy = await fetch(proxyUrl);
        if (!resProxy.ok) throw new Error("Proxy denegado");
        html = await resProxy.text();
      } catch (e2) {
        // Último intento con CodeTabs (por si no lo habíamos forzado antes)
        if (!forzarCodeTabs) {
            console.log(`   ⚠️ AllOrigins bloqueado. Activando Plan D (Proxy CodeTabs)...`);
            try {
              const proxyUrl2 = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`;
              const resProxy2 = await fetch(proxyUrl2);
              if (!resProxy2.ok) throw new Error("Proxy CodeTabs denegado");
              html = await resProxy2.text();
            } catch (e3) {
              console.error(`   ❌ Imposible acceder a la web con ningún método: ${url}`);
              return { texto: null, pdf: null }; 
            }
        } else {
            console.error(`   ❌ Imposible acceder a la web con ningún método: ${url}`);
            return { texto: null, pdf: null };
        }
      }
    }
  }

  const $ = cheerio.load(html);
  let pdfLink = null;

  // 🚀 PARCHE BOA (Aragón): Cazar el PDF MLKOB directamente del código fuente
  if (url.includes('boa.aragon.es')) {
      const matchMlkob = html.match(/CMD=VEROBJ[^"']*(?:MLKOB=\d+)[^"']*type=pdf/i);
      if (matchMlkob) {
          pdfLink = `https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI?${matchMlkob[0].replace(/&amp;/g, '&')}`;
      }
  }
  
  // 🧠 MAGIA AQUÍ: Convertimos los enlaces <a> en texto Markdown para que la IA los vea
  $('a').each((i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      
      // Guardamos el PDF directo si lo hay (Escudo Anti-PDF)
      // 🚀 AÑADIDO 'type=pdf' PARA CAZAR EL CÓDIGO MLKOB DEL BOA
      if (href.toLowerCase().includes('.pdf') || href.toLowerCase().includes('descargararchivo') || href.toLowerCase().includes('document-del-dogc') || href.toLowerCase().includes('type=pdf')) {
          if (!pdfLink) {
              try { pdfLink = new URL(href, url).href; } catch(e){}
          }
      }
      
      // Reescribimos el texto del enlace para que .text() no lo borre
      const textoEnlace = $(el).text().replace(/\s+/g, ' ').trim();
      if (textoEnlace && !href.startsWith('javascript') && !href.startsWith('#')) {
          $(el).text(`[${textoEnlace}](${href})`);
      }
  });

  $('script, style, nav, footer, header, aside').remove();
  let textoLimpio = $('#textoxslt').text(); 
  if (!textoLimpio) textoLimpio = $('body').text(); 
  textoLimpio = textoLimpio.replace(/\s+/g, ' ').trim();

  if (url.includes('dogc.gencat.cat')) textoLimpio = limpiarBasuraDOGC(textoLimpio);

  return { texto: textoLimpio.substring(0, 15000), pdf: pdfLink };
}

// 🛡️ HELPER DE NAVEGADOR (Mejorado con selector de contenido principal)
async function obtenerTextoUniversal(url, reintentos = 3) {
  try {
    // Si estamos en el DOGC, le decimos a Cloudflare que solo extraiga el contenedor del documento
    let selector = "";
    let payload = { url: url };

    if (url.includes('dogc.gencat.cat')) {
        selector = "div.container, main, article, #content, .content"; // Selectores comunes de texto principal
        payload = { 
            url: url,
            waitFor: 5000 // Esperamos 5 segundos a que desaparezca el "Cargando..."
        };
    }
   
    // Cloudflare browser-rendering admite opciones adicionales. Si es el DOGC, intentamos aislar el texto.
    // Como el endpoint de Markdown a veces devuelve todo, vamos a asegurarnos de que la IA sepa qué buscar.
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering/markdown`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload) 
    });

    if (response.status === 429) {
      if (reintentos > 0) {
         const tiempoPausa = (4 - reintentos) * 5000; 
         console.log(`   ⏳ Límite de Cloudflare (429). Pausa de ${tiempoPausa/1000}s...`);
         await esperar(tiempoPausa); 
         return obtenerTextoUniversal(url, reintentos - 1); 
      } else {
         console.log(`   ❌ Cloudflare agotó los reintentos (429). Activando salvavidas Nativo/Proxy para: ${url}`);
         const nativo = await obtenerTextoNativo(url);
         return nativo.texto;
      }
    }

    if (response.status === 422 || response.status === 403 || response.status === 400) {
      console.log(`   ⚠️ Cloudflare bloqueado (Status ${response.status}). Activando Plan B (Vía Nativa)...`);
      const nativo = await obtenerTextoNativo(url);
      return nativo.texto;
    }

    if (!response.ok) return null;
    
    const data = await response.json();
    let textoLimpio = data.result || "";
    
   if (url.includes('dogc.gencat.cat')) textoLimpio = limpiarBasuraDOGC(textoLimpio);

    return typeof textoLimpio === "string" ? textoLimpio.substring(0, 80000) : ""; 
  } catch (error) {
    return null; 
  }
}

// 🚀 NUEVO: Conexión directa a la API REST del DOGC (Cataluña)
async function obtenerDOGCporAPI() {
    console.log(`   🔌 Conectando directamente a la API REST del DOGC...`);
    
    const hoy = new Date();
    const dd = String(hoy.getDate()).padStart(2, '0');
    const mm = String(hoy.getMonth() + 1).padStart(2, '0');
    const yyyy = hoy.getFullYear();
    const fechaFormat = `${dd}/${mm}/${yyyy}`;

    // Replicamos el payload exacto que el usuario descubrió
    const payload = {
        "typeSearch": "1",
        "value": "",
        "title": true,
        "current": true,
        "range": [],
        "issuingAuthority": [],
        "publicationDateInitial": fechaFormat,
        "publicationDateFinal": "",
        "dispositionDateInitial": "",
        "dispositionDateFinal": "",
        "sectionDOGC": [],
        "thematicDescriptor": ["D4090", "DE1738"], // Filtro oficial: "Oposiciones" y "Personal"
        "organizationDescriptor": [],
        "geographicDescriptor": [],
        "aranese": "",
        "expandSearchFullText": "",
        "noCurrent": "",
        "orderBy": "3",
        "page": 1,
        "numResultsByPage": 50, // Ponemos 50 para asegurarnos de que entran todas las del día
        "advanced": true,
        "language": "es",
        "subject": []
    };

    try {
        const response = await fetch("https://portaldogc.gencat.cat/eadop-rest/api/dogc/searchDOGC", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) throw new Error(`Status ${response.status}`);
        const data = await response.json();
        
        if (data && data.resultSearch && data.resultSearch.length > 0) {
           return data.resultSearch.map(item => {
                   let dep = null;
                   if (item.issuingAuthority && item.issuingAuthority.length > 0) dep = item.issuingAuthority[0];
                   else if (item.organizationDescriptor && item.organizationDescriptor.length > 0) dep = item.organizationDescriptor[0];

                   let linkPdfLimpio = item.linkDownloadPDF || '';
                   if (linkPdfLimpio && linkPdfLimpio.startsWith('//')) linkPdfLimpio = 'https:' + linkPdfLimpio;
                   if (linkPdfLimpio && linkPdfLimpio.startsWith('dogc.gencat.cat')) linkPdfLimpio = 'https://' + linkPdfLimpio;

                   return {
                       titulo: item.title,
                       enlace: `https://dogc.gencat.cat/es/document-del-dogc/?documentId=${item.idDocument}`,
                       pdf: linkPdfLimpio, // Pasamos el PDF limpio
                       departamento: dep 
                   };
               });
        }
        return [];
    } catch (e) {
        console.error(`   ❌ Error llamando a la API del DOGC: ${e.message}`);
        return null;
    }
}

// 🛡️ HELPER NATIVO INDESTRUCTIBLE: Evita los bloqueos del "fetch" moderno de Node.js
function fetchNativoSeguro(url, cookie = "") {
    return new Promise((resolve, reject) => {
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': '*/*'
            },
            rejectUnauthorized: false // Ignora certificados caducados sin importar la versión de Node
        };
        if (cookie) options.headers['Cookie'] = cookie;

        https.get(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                resolve({ 
                    ok: res.statusCode === 200, 
                    status: res.statusCode, 
                    text: data,
                    headers: res.headers
                });
            });
        }).on('error', err => reject(err));
    });
}

// 🚀 NUEVO: Buscador Matemático para BOC Cantabria (Vía HTML + CodeTabs + Cheerio Definitivo)
async function obtenerCantabriaMatematico() {
    console.log(`   🧮 Iniciando Buscador Matemático para Cantabria (Vía HTML + Cheerio Definitivo)...`);
    
    const cheerio = require("cheerio");
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0); 
    
    const formatoHoy = `${String(hoy.getDate()).padStart(2, '0')}/${String(hoy.getMonth() + 1).padStart(2, '0')}/${hoy.getFullYear()}`;
    const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const textoHoy = `${hoy.getDate()} de ${meses[hoy.getMonth()]} de ${hoy.getFullYear()}`;
    
    const fechaAncla = new Date('2026-04-16T00:00:00');
    let diasHabiles = 0;
    let fechaTemp = new Date(fechaAncla);
    
    while (fechaTemp < hoy) {
        fechaTemp.setDate(fechaTemp.getDate() + 1);
        const diaSemana = fechaTemp.getDay();
        if (diaSemana !== 0 && diaSemana !== 6) diasHabiles++;
    }

    let idEstimado = 44565 + (diasHabiles * 20);
    let intentos = 0;
    let convocatorias = [];

    while (intentos < 10) {
        const htmlUrl = `https://boc.cantabria.es/boces/verBoletin.do?idBolOrd=${idEstimado}`;
        console.log(`   🔎 Tanteando HTML en: ${htmlUrl}`); 
        
        try {
            let htmlText = null;

            try {
                const proxyUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(htmlUrl)}`;
                const res = await fetch(proxyUrl);
                if (res.ok) {
                    htmlText = await res.text();
                } else {
                    console.log(`      ⚠️ Status Proxy CodeTabs ${res.status}`);
                }
            } catch (err) {
                console.log(`      ⚠️ Fallo de red Proxy: ${err.message}`);
            }

            if (!htmlText) throw new Error("Respuesta vacía del proxy.");

            if (htmlText.includes('No se han encontrado resultados') || htmlText.includes('Ha ocurrido un error')) {
                console.log(`      ⏩ El ID ${idEstimado} no existe aún. Retrocediendo...`);
                idEstimado -= 20;
                intentos++;
                continue;
            }
            
            // 🎯 ¡BINGO!
            if (htmlText.toLowerCase().includes(textoHoy.toLowerCase()) || htmlText.includes(formatoHoy)) {
                console.log(`   🎯 ¡Bingo! Boletín de hoy encontrado en el ID: ${idEstimado}`);
                
                const $ = cheerio.load(htmlText);
                let cazadas = 0;
                let linksAnuncios = 0;
                
                let anunciosProcesados = new Set(); // Para no duplicar
                
                $('a').each((i, el) => {
                    let href = $(el).attr('href') || '';
                    let realHref = href;
                    if (href.includes('api.codetabs.com')) {
                        try {
                            const matchQuest = href.match(/quest=([^&]+)/);
                            if (matchQuest) realHref = decodeURIComponent(matchQuest[1]);
                        } catch(e){}
                    }

                    if (!realHref.includes('verAnuncioAction.do') && !realHref.includes('idAnuBlob')) return; 
                    
                    let linkText = $(el).text().toUpperCase().replace(/\s+/g, ' ').trim();
                    let isHTML = linkText.includes('HTML (BOC');
                    let isPDF = linkText.includes('PDF (BOC');
                    
                    if (!isHTML && !isPDF) return;

                    // Extraemos el ID del anuncio para no procesarlo 2 veces
                    let idAnuncio = realHref.match(/idAnuBlob=([^&]+)/);
                    if (!idAnuncio) return;
                    let idAnu = idAnuncio[1];
                    
                    if (anunciosProcesados.has(idAnu)) return; // Ya lo cazamos por el otro botón

                    // Si estamos en un botón PDF, miramos si hay uno HTML
                    if (isPDF) {
                        let hasHTML = $(el).siblings('a').filter((idx, e) => $(e).text().toUpperCase().includes('HTML (BOC')).length > 0;
                        if (hasHTML) return; // Lo ignoramos, ya lo cogerá cuando el bucle pase por el botón HTML
                    }
                    
                    // Si llegamos aquí, o es HTML, o es un PDF huérfano. Lo marcamos como procesado.
                    anunciosProcesados.add(idAnu);

                    // --- EXTRACCIÓN QUIRÚRGICA DEL TÍTULO ---
                    let clone = $(el).parent().clone();
                    clone.find('a').remove(); 
                    clone.find('img').remove();
                    let txtMismoBloque = clone.text().replace(/\s+/g, ' ').trim();
                    
                    let txtBloqueAnterior = $(el).parent().prev().text().replace(/\s+/g, ' ').trim();
                    let txtHermanoAnterior = $(el).prev().text().replace(/\s+/g, ' ').trim();
                    
                    let tituloLimpio = "";
                    if (txtMismoBloque.length > 20) tituloLimpio = txtMismoBloque;
                    else if (txtBloqueAnterior.length > 20) tituloLimpio = txtBloqueAnterior;
                    else if (txtHermanoAnterior.length > 20) tituloLimpio = txtHermanoAnterior;
                    else tituloLimpio = $(el).parent().parent().prev().text().replace(/\s+/g, ' ').trim();

                    if (tituloLimpio) {
                        let t = tituloLimpio.toLowerCase();
                        if (t.includes('oposición') || t.includes('oposicion') || t.includes('concurso') || 
                            t.includes('provisión') || t.includes('plaza') || t.includes('bolsa') || 
                            t.includes('selectiv')) {
                            
                            cazadas++;
                            
                            let enlaceWeb = realHref.replace(/&amp;/g, '&');
                            if (!enlaceWeb.startsWith('http')) enlaceWeb = 'https://boc.cantabria.es/boces/' + enlaceWeb.replace(/^\//, '');
                            
                            let pdfHref = isPDF ? enlaceWeb : '';
                            if (!isPDF) {
                                pdfHref = $(el).siblings('a').filter((idx, e) => $(e).text().toUpperCase().includes('PDF (BOC')).attr('href') || '';
                                if (pdfHref) {
                                    if (pdfHref.includes('api.codetabs.com')) {
                                        try {
                                            const m = pdfHref.match(/quest=([^&]+)/);
                                            if (m) pdfHref = decodeURIComponent(m[1]);
                                        } catch(e){}
                                    }
                                    if (!pdfHref.startsWith('http')) pdfHref = 'https://boc.cantabria.es/boces/' + pdfHref.replace(/^\//, '');
                                }
                            }

                            convocatorias.push({
                                titulo: tituloLimpio,
                                enlace: enlaceWeb, // ¡Ahora será HTML garantizado si existe!
                                pdf: pdfHref || enlaceWeb
                            });
                        }
                    }
                });
                
                console.log(`      📊 Stats Cheerio: De ${linksAnuncios} anuncios oficiales, ¡${cazadas} plazas cazadas con bisturí!`);
                return convocatorias; 
                
            } else {
                const extractDate = htmlText.match(/(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})/i);
                if (extractDate) {
                   const d = parseInt(extractDate[1]);
                   const mStr = extractDate[2].toLowerCase();
                   const y = parseInt(extractDate[3]);
                   const m = meses.indexOf(mStr);
                   const dateBoletin = new Date(y, m, d);
                   
                   if (dateBoletin < hoy) {
                       console.log(`   ⚖️ Calibrando: El ID ${idEstimado} es del ${extractDate[0]}. Avanzando +20...`);
                       idEstimado += 20;
                   } else {
                       console.log(`   ⚖️ Calibrando: El ID ${idEstimado} es del ${extractDate[0]}. Retrocediendo -20...`);
                       idEstimado -= 20;
                   }
                } else {
                   console.log(`   ⚖️ Calibrando a ciegas. Retrocediendo -20...`);
                   idEstimado -= 20;
                }
            }
        } catch (e) {
            console.log(`   ⚠️ Error: ${e.message}`);
            idEstimado -= 20; 
        }
        intentos++;
    }
    
    console.log("   ⏭️ No se pudo encontrar el boletín de hoy de Cantabria con la fórmula matemática.");
    return null;
}



// 1. EL TANQUE BINARIO (Indestructible: Combina HTTPS nativo y Proxy de respaldo)
function descargarPdfBinario(url) {
    return new Promise((resolve, reject) => {
        const options = {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            rejectUnauthorized: false // 🛡️ Esto nos salta el cortafuegos de Akamai (DOGC)
        };
        const req = https.get(url, options, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                let newUrl = res.headers.location;
                if (!newUrl.startsWith('http')) newUrl = new URL(newUrl, url).href;
                return resolve(descargarPdfBinario(newUrl));
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP Status ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', err => reject(err));
        req.setTimeout(8000, () => { req.destroy(); reject(new Error("Timeout")); });
    }).catch(async (err) => {
        // 🔄 Si la red directa falla (como pasa con la IP de Cantabria), usamos el Proxy Ninja
        console.log(`   🩻 [Rayos X] Red directa bloqueada (${err.message}). Usando Proxy...`);
        const proxyUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`;
        const resProxy = await fetch(proxyUrl);
        if (resProxy.ok) {
            return Buffer.from(await resProxy.arrayBuffer());
        }
        throw new Error(`Proxy falló con Status ${resProxy.status}`);
    });
}

// 2. VISIÓN DE RAYOS X (Limpia y estable para pdf-parse 1.1.1)
async function extraerTextoDePDF(pdfUrl) {
    console.log(`   🩻 [Rayos X] Descargando y leyendo PDF interno...`);
    try {
        // Descargamos el binario (con proxy si hay cortafuegos)
        const buffer = await descargarPdfBinario(pdfUrl);
        
        // Importamos la librería oficial
        const pdfParser = require('pdf-parse'); 

        // Extraemos el texto
        const data = await pdfParser(buffer);
        let textoLimpio = data.text.replace(/\s+/g, ' ').trim();
        return textoLimpio;
    } catch (error) {
        console.error(`   ❌ Error leyendo PDF con Rayos X: ${error.message}`);
        return null;
    }
}

// 3. LIMPIEZA EXTREMA DEL DOGC (Cuchillo quirúrgico para menús)
function limpiarBasuraDOGC(texto) {
    if (!texto) return texto;
    let limpio = texto
        .replace(/\[ Saltar al contenido principal\][^\n]+/gi, '')
        .replace(/\[ \!\[Logotipo.*?Vés a la pàgina inici"\)/gi, '')
        .replace(/Menú[\s\S]*?Área privada/gi, '') // Quita el menú
        .replace(/Salir rápido[\s\S]*?\[esborrar-historial\]/gi, '')
        .trim();
        
    // Cuchillo final: Corta todo lo que haya antes de la primera palabra oficial
    const match = limpio.match(/(RESOLUCIÓN|RESOLUCION|ANUNCIO|EDICTO|CORRECCIÓN|CORRECCION|ACUERDO)\b/i);
    if (match) {
        const startIdx = limpio.indexOf(match[0]);
        if (startIdx !== -1 && startIdx < 5000) return limpio.substring(startIdx).trim();
    }
    return limpio;
}

module.exports = {
  obtenerTextoNativo,
  obtenerTextoUniversal,
  obtenerDOGCporAPI,
  obtenerCantabriaMatematico,
  extraerTextoDePDF
};
