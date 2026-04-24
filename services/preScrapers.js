const { obtenerTextoNativo, obtenerTextoUniversal, fetchNativoSeguro } = require('./scraper');

// 🛡️ TÁCTICA AVANZADA: Simular un móvil para saltar WAFs (Cortafuegos) de alta seguridad
async function burlarCortafuegos(url) {
    try {
        const res = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "es-ES,es;q=0.9",
                "Cache-Control": "no-cache",
                "Pragma": "no-cache"
            }
        });
        if (res.ok) return await res.text();
        return null;
    } catch (e) {
        return null;
    }
}

// ==========================================
// ARCHIVO: services\preScrapers.js
// SUSTITUYE LA FUNCIÓN ENTERA obtenerUrlDelDia
// ==========================================

async function obtenerUrlDelDia(fuente) {
    console.log(`   🕵️‍♂️ Ejecutando Pre-Scraping Táctico para ${fuente.nombre}...`);
    
    // 🛡️ PARCHE ZONA HORARIA
    const fechaEspañaStr = new Date().toLocaleString("en-US", { timeZone: "Europe/Madrid" });
    const hoy = new Date(fechaEspañaStr);
    const dd = String(hoy.getDate()).padStart(2, '0');
    const mm = String(hoy.getMonth() + 1).padStart(2, '0');
    const yyyy = hoy.getFullYear();

    // ==========================================
    // 0. CATALUÑA (DOGC): INGENIERÍA MATEMÁTICA
    // ==========================================
    if (fuente.nombre === "DOGC") {
        console.log(`   🧮 Calculando ID matemático para el Sumario del DOGC...`);
        hoy.setHours(0,0,0,0);
        // 🛡️ PARCHE ZONA HORARIA
    
        const fechaAncla = new Date('2026-04-17T00:00:00').toLocaleString("en-US", { timeZone: "Europe/Madrid" });
        const idAncla = 9647; // Nuestro número ancla descubierto por ti
        let diasHabiles = 0;
        let fechaTemp = new Date(fechaAncla);

        while (fechaTemp < hoy) {
            fechaTemp.setDate(fechaTemp.getDate() + 1);
            const diaSemana = fechaTemp.getDay();
            if (diaSemana !== 0 && diaSemana !== 6) diasHabiles++;
        }
        
        let idEstimado = idAncla + diasHabiles;
        const year = hoy.getFullYear();
        const month = hoy.getMonth() + 1;
        
        let intentos = 0;
        let urlDOGC = "";

        // Tanteamos hacia atrás por si hubo algún día festivo sin publicación
       while (intentos < 5) {
            urlDOGC = `https://dogc.gencat.cat/es/sumari-del-dogc/?selectedYear=${year}&selectedMonth=${month}&numDOGC=${idEstimado}&language=es_ES`;
            console.log(`   🔎 Tanteando DOGC ID ${idEstimado}...`);
            
            try {
                // Usamos el tanque porque CodeTabs está bloqueado por la Generalitat
                const res = await fetchNativoSeguro(urlDOGC);
                if (res.ok) {
                    const htmlText = res.text;
                    const diaF = hoy.getDate();
                    const esHoy = htmlText.includes(`${diaF}.${month}.${year}`) || htmlText.includes(`${String(diaF).padStart(2,'0')}.${String(month).padStart(2,'0')}.${year}`);
                                  
                    if (esHoy) {
                        console.log(`   🎯 ¡Bingo! DOGC de hoy encontrado con ID: ${idEstimado}`);
                        fuente.numDOGC_calculado = idEstimado; 
                        return urlDOGC;
                    }
                }
            } catch(e) { }
            
            // Si llega aquí, es que no era de hoy o la red falló. Restamos 1 seguro.
            console.log(`   ⚖️ Calibrando fecha. El ID ${idEstimado} no es de hoy o falló la red. Probando anterior...`);
            idEstimado--;
            intentos++;
        }
        
        console.log(`   ⚠️ No se pudo confirmar el DOGC exacto. Usando aproximación matemática pura.`);
        fuente.numDOGC_calculado = idAncla + diasHabiles;
        return `https://dogc.gencat.cat/es/sumari-del-dogc/?selectedYear=${year}&selectedMonth=${month}&numDOGC=${fuente.numDOGC_calculado}&language=es_ES`;
    }
   
    // ==========================================
    // 1. LA RIOJA (BOR): ATAQUE API EN CASCADA
    // ==========================================
    if (fuente.nombre === "BOR") {
        try {
            const fechaBor = `${dd}/${mm}/${yyyy}`; // Ej: 24/04/2026
            const apiUrl = `https://web.larioja.org/bor-api/busquedas/boletines?fecha=${fechaBor}`;
            console.log(`   🔎 Tanteando API secreta BOR: ${apiUrl}`);
            
            let jsonText = null;
            let exito = false;

            // 🛡️ Intento 1: Proxy AllOrigins (Ideal para JSON)
            try {
                const res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(apiUrl)}`);
                if (res.ok) {
                    jsonText = await res.text();
                    exito = true;
                    console.log(`      ✅ API cargada vía AllOrigins`);
                }
            } catch (e) {}

            // 🛡️ Intento 2: Proxy CodeTabs
            if (!exito) {
                try {
                    const res = await fetch(`https://api.codetabs.com/v1/proxy?quest=${apiUrl}`);
                    if (res.ok) {
                        jsonText = await res.text();
                        exito = true;
                        console.log(`      ✅ API cargada vía CodeTabs`);
                    }
                } catch (e) {}
            }

            // 🛡️ Intento 3: Tanque Nativo
            if (!exito) {
                try {
                    const res = await fetchNativoSeguro(apiUrl);
                    if (res.ok) {
                        jsonText = res.text;
                        exito = true;
                        console.log(`      ✅ API cargada vía Conexión Nativa`);
                    }
                } catch (e) {}
            }

            if (exito && jsonText) {
                try {
                    const data = JSON.parse(jsonText);
                    if (data && data.boletines && data.boletines.length > 0) {
                        const boletinHoy = data.boletines[0];
                        console.log(`   🎯 ¡Bingo! BOR de hoy encontrado con ID: ${boletinHoy.idBoletin}`);
                        return `https://web.larioja.org/bor-boletin?id=${boletinHoy.idBoletin}`;
                    } else {
                        console.log(`   ⚠️ La API respondió correctamente, pero está vacía. (No hay publicación hoy)`);
                        return null;
                    }
                } catch (e) {
                    console.log(`   ⚠️ BOR no devolvió JSON válido.`);
                    return null;
                }
            } else {
                console.log(`   ❌ Todos los métodos fallaron al cargar la API del BOR.`);
                return null;
            }
        } catch (e) {
            console.log(`   ⚠️ Fallo crítico BOR: ${e.message}`);
            return null;
        }
    }

    
    // ==========================================
    // 2. CEUTA (BOCCE) - VÍA NATIVA DIRECTA
    // ==========================================
    if (fuente.nombre === "BOCCE") {
        try {
            const urlXml = "https://www.ceuta.es/ceuta/bocce/ultimos";
            // Usamos tu scraper nativo forzado para no quemar la API de Cloudflare
            const nativo = await obtenerTextoNativo(urlXml, true);
            const htmlBocce = nativo ? nativo.texto : "";

            // Tu función nativa convierte enlaces a [Texto](url). Buscamos el primer PDF:
            const match = htmlBocce.match(/\]\(([^)]+\.pdf)\)/i);
            if (match) {
                let link = match[1];
                if (!link.startsWith('http')) link = "https://www.ceuta.es" + (link.startsWith('/') ? '' : '/') + link;
                return link;
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    // ==========================================
    // 3. MELILLA (BOME) - VÍA NATIVA DIRECTA
    // ==========================================
    if (fuente.nombre === "BOME") {
        try {
            const urlBome = "https://bomemelilla.es/boletines/ordinarios"; 
            const nativo = await obtenerTextoNativo(urlBome, true);
            const htmlBome = nativo ? nativo.texto : "";

            const match = htmlBome.match(/\]\(([^)]+\.pdf)\)/i);
            if (match) {
                let link = match[1];
                if (!link.startsWith('http')) link = "https://bomemelilla.es" + (link.startsWith('/') ? '' : '/') + link;
                return link;
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    return fuente.url;
}

module.exports = { obtenerUrlDelDia };