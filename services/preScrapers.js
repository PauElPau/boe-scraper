const { obtenerTextoNativo, obtenerTextoUniversal } = require('./scraper');

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
    if (fuente.nombre === "DOGC") return "API_REST";

    console.log(`   🕵️‍♂️ Ejecutando Pre-Scraping Táctico para ${fuente.nombre}...`);
    
    const hoy = new Date();
    const dd = String(hoy.getDate()).padStart(2, '0');
    const mm = String(hoy.getMonth() + 1).padStart(2, '0');
    const yyyy = hoy.getFullYear();

    // ==========================================
    // 1. LA RIOJA (BOR): ATAQUE API DIRECTO VÍA PROXY
    // ==========================================
    if (fuente.nombre === "BOR") {
        try {
            const fechaBor = `${yyyy}-${mm}-${dd}`;
            const apiUrl = `https://web.larioja.org/bor-api/busquedas/boletines?fecha=${fechaBor}`;
            
            // Usamos CodeTabs para evitar el 'fetch failed' de Node.js
            const proxyUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(apiUrl)}`;
            const res = await fetch(proxyUrl);
            
            if (res.ok) {
                const textData = await res.text();
                try {
                    const data = JSON.parse(textData);
                    if (data && data.boletines && data.boletines.length > 0) {
                        return `https://web.larioja.org/bor-boletin?id=${data.boletines[0].idBoletin}`;
                    }
                } catch(e) {
                    console.log(`      ⚠️ BOR no devolvió JSON válido hoy.`);
                }
            }
            return null;
        } catch (e) {
            console.log(`      ⚠️ Fallo API BOR: ${e.message}`);
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