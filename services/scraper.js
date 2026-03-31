const cheerio = require("cheerio");
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
  return { texto: textoLimpio.substring(0, 15000), pdf: pdfLink };
}

async function obtenerTextoUniversal(url, reintentos = 3) {
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering/markdown`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url: url }) 
    });

    if (response.status === 429) {
      if (reintentos > 0) {
         const tiempoPausa = (4 - reintentos) * 5000; 
         console.log(`   ⏳ Límite de Cloudflare (429). Pausa de ${tiempoPausa/1000}s...`);
         await esperar(tiempoPausa); 
         return obtenerTextoUniversal(url, reintentos - 1); 
      } else {
         // 🛡️ SALVAVIDAS: Si Cloudflare se rinde, no devolvemos null, intentamos la ruta nativa/proxy
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
            return data.resultSearch.map(item => ({
                titulo: item.title,
                // Construimos la URL HTML pública usando el idDocument
                enlace: `https://dogc.gencat.cat/es/document-del-dogc/?documentId=${item.idDocument}`,
                pdf: item.linkDownloadPDF
            }));
        }
        return [];
    } catch (e) {
        console.error(`   ❌ Error llamando a la API del DOGC: ${e.message}`);
        return null;
    }
}

// 🚀 NUEVO: Buscador Matemático para BOC Cantabria (Bypass TLS y Proxies RAW)
async function obtenerCantabriaMatematico() {
    console.log(`   🧮 Iniciando Buscador Matemático para Cantabria (Ancla: 31/03/2026 - ID: 44405)...`);
    
    const hoy = new Date();
    const formatoHoy = `${String(hoy.getDate()).padStart(2, '0')}/${String(hoy.getMonth() + 1).padStart(2, '0')}/${hoy.getFullYear()}`;
    
    const fechaAncla = new Date('2026-03-31T00:00:00');
    let diasHabiles = 0;
    let fechaTemp = new Date(fechaAncla);
    
    while (fechaTemp < hoy) {
        fechaTemp.setDate(fechaTemp.getDate() + 1);
        const diaSemana = fechaTemp.getDay();
        if (diaSemana !== 0 && diaSemana !== 6) diasHabiles++;
    }

    let idEstimado = 44405 + (diasHabiles * 20);
    let intentos = 0;
    let convocatorias = [];
    
    // 🛡️ TRUCO MÁGICO: Guardamos la configuración original de seguridad TLS de tu servidor
    const originalTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    
    while (intentos < 5) {
        const xmlUrl = `https://boc.cantabria.es/boces/verXmlAction.do?idBlob=${idEstimado}`;
        console.log(`   🔎 Tanteando XML en: ${xmlUrl}`); 
        
        try {
            let xmlText = null;
            
            // INTENTO 1: Fetch Nativo (Desactivando el candado estricto para evitar el "fetch failed")
            try {
                process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // Bajamos escudos temporalmente
                const res = await fetch(xmlUrl, {
                    headers: { 
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36",
                        "Accept": "application/xml, text/xml, */*; q=0.01"
                    }
                });
                if (res.ok) {
                    xmlText = await res.text();
                } else {
                    console.log(`      ⚠️ Fallo HTTP Directo: Status ${res.status}`);
                }
            } catch (err) {
                console.log(`      ⚠️ Fallo de Red Directo: ${err.message}`);
            } finally {
                process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalTls; // Restauramos escudos inmediatamente
            }

            // INTENTO 2: Proxy AllOrigins en modo RAW (Especial para archivos gigantes, no los corta)
            if (!xmlText) {
                console.log(`      🔄 Lanzando Proxy AllOrigins (Modo RAW)...`);
                try {
                    const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(xmlUrl)}`;
                    const resProxy = await fetch(proxyUrl, { headers: { "User-Agent": "Mozilla/5.0" }});
                    if (resProxy.ok) xmlText = await resProxy.text();
                } catch(e) {}
            }

            // INTENTO 3: Proxy CodeTabs
            if (!xmlText) {
                console.log(`      🔄 Lanzando Proxy CodeTabs...`);
                try {
                    const resProxy2 = await fetch(`https://api.codetabs.com/v1/proxy/?quest=${xmlUrl}`, { headers: { "User-Agent": "Mozilla/5.0" }});
                    if (resProxy2.ok) xmlText = await resProxy2.text();
                } catch(e) {}
            }

            // LIMPIEZA DE PROXIES (Desencriptar los < > rotos si pasamos por proxy)
            if (xmlText) {
                xmlText = xmlText.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
            }

            // 🚀 ESCUDO DE 404: Si Cantabria devuelve su página HTML de error, es que el boletín aún no existe
            if (xmlText && (xmlText.includes('<!DOCTYPE HTML>') || xmlText.includes('No hay documento'))) {
                console.log(`      ⏩ El ID ${idEstimado} no existe en el servidor (Aún no publicado o festivo). Retrocediendo...`);
                idEstimado -= 20;
                intentos++;
                continue;
            }

            // CHIVATO DE ERRORES REALES
            if (!xmlText || !xmlText.includes('</root>')) {
                const preview = xmlText ? xmlText.substring(0, 100).replace(/\n/g, '') : 'TOTALMENTE VACÍO (NULL)';
                console.log(`      ❌ Respuesta Inválida. Fragmento recibido: ${preview}`);
                throw new Error("El archivo no pudo descargarse o fue bloqueado por límite de tamaño.");
            }
            
            // EXTRACCIÓN Y LÓGICA DE FECHAS
            const matchFecha = xmlText.match(/<Fecha\s+fecha="([^"]+)">/i);
            const fechaBoletin = matchFecha ? matchFecha[1] : null;
            
            if (fechaBoletin === formatoHoy) {
                console.log(`   🎯 ¡Bingo! Boletín de hoy encontrado en el ID: ${idEstimado}`);
                
                const regexDisposicion = /<disposicion\s+fechaDis="[^"]+"[^>]*>([\s\S]*?)<\/disposicion>/g;
                let matchDisp;
                
                while ((matchDisp = regexDisposicion.exec(xmlText)) !== null) {
                    const bloque = matchDisp[1];
                    const tituloMatch = bloque.match(/<titulo_text>([^<]+)<\/titulo_text>/);
                    const enlaceMatch = bloque.match(/<num_exp\s+url="([^"]+)">/);
                    
                    if (tituloMatch && enlaceMatch) {
                        const titulo = tituloMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
                        const htmlDisposicion = enlaceMatch[1].replace(/&amp;/g, '&');
                        
                        const t = titulo.toLowerCase();
                        if (t.includes('oposición') || t.includes('oposicion') || t.includes('concurso') || 
                            t.includes('provisión') || t.includes('plaza') || t.includes('bolsa') || 
                            t.includes('selectiv')) {
                            
                            convocatorias.push({
                                titulo: titulo,
                                enlace: htmlDisposicion, 
                                pdf: htmlDisposicion
                            });
                        }
                    }
                }
                return convocatorias; 
                
            } else if (fechaBoletin) {
                const partes = fechaBoletin.split('/');
                const dateBoletin = new Date(`${partes[2]}-${partes[1]}-${partes[0]}T00:00:00`);
                
                if (dateBoletin < hoy) {
                    console.log(`   ⚖️ Calibrando: El ID ${idEstimado} es del ${fechaBoletin}. Avanzando +20...`);
                    idEstimado += 20;
                } else {
                    console.log(`   ⚖️ Calibrando: El ID ${idEstimado} es del ${fechaBoletin}. Retrocediendo -20...`);
                    idEstimado -= 20;
                }
            } else {
                console.log(`   ⚠️ No se encontró la etiqueta de fecha.`);
                idEstimado += 20;
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

module.exports = {
  obtenerTextoNativo,
  obtenerTextoUniversal,
  obtenerDOGCporAPI,
  obtenerCantabriaMatematico
};
