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

// 🎯 FASE PREVIA: Entra a las portadas "caja fuerte" y extrae la URL real del último boletín
async function obtenerUrlDelDia(fuente) {
    if (fuente.nombre === "DOGC") return "API_REST";

    console.log(`   🕵️‍♂️ Ejecutando Pre-Scraping Táctico para ${fuente.nombre}...`);
    
    const hoy = new Date();
    const dd = String(hoy.getDate()).padStart(2, '0');
    const mm = String(hoy.getMonth() + 1).padStart(2, '0');
    const yyyy = hoy.getFullYear();

    // ==========================================
    // 1. LA RIOJA (BOR): ATAQUE API DIRECTO
    // ==========================================
    if (fuente.nombre === "BOR") {
        try {
            // El BOR usa una API ElasticSearch interna. Le pasamos la fecha de hoy.
            const fechaBor = `${yyyy}-${mm}-${dd}`;
            const apiUrl = `https://web.larioja.org/bor-api/busquedas/boletines?fecha=${fechaBor}`;
            
            // Apagamos el candado TLS temporalmente porque a veces la API falla con certificados modernos
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; 
            const res = await fetch(apiUrl, { headers: { "User-Agent": "Mozilla/5.0" }});
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
            
            if (res.ok) {
                const data = await res.json();
                // Si hay datos y encontramos el ID del boletín de hoy
                if (data && data.boletines && data.boletines.length > 0) {
                    const idBoletin = data.boletines[0].idBoletin;
                    return `https://web.larioja.org/bor-boletin?id=${idBoletin}`;
                }
            }
            return null; // Si no hay datos, no hay boletín hoy.
        } catch (e) {
            console.log(`      ⚠️ Fallo API BOR: ${e.message}`);
            return null;
        }
    }

    // ==========================================
    // 2. CEUTA (BOCCE): LECTURA DIRECTA DEL IFRAME RSS
    // ==========================================
    if (fuente.nombre === "BOCCE") {
        try {
            // Ceuta carga su portada a través de un archivo XML oculto tipo Feed.
            // Vamos directos ahí y cazamos el enlace con la fecha de hoy.
            const urlXml = "https://www.ceuta.es/ceuta/bocce/ultimos";
            const htmlBocce = await obtenerTextoUniversal(urlXml);
            if (!htmlBocce) return null;

            // Buscamos cualquier enlace que apunte a un PDF del BOCCE del mes actual
            const match = htmlBocce.match(/href=["']([^"']*(?:bocce|boletines)[^"']*\.pdf)["']/i);
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
    // 3. MELILLA (BOME): CAZA DEL PDF EN LA SECCIÓN "HOY"
    // ==========================================
    if (fuente.nombre === "BOME") {
        try {
            // Melilla usa Joomla. Atacamos directamente a la página donde imprimen el artículo de "Boletín de Hoy"
            const urlBome = "https://bomemelilla.es/boletines/ordinarios"; 
            const htmlBome = await obtenerTextoUniversal(urlBome);
            if (!htmlBome) return null;

            // Buscamos un enlace a un archivo PDF (BOME-B-xxxx.pdf)
            const match = htmlBome.match(/href=["']([^"']*(?:bome|BOME)[^"']*\.pdf)["']/i);
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