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

    console.log(`   🕵️‍♂️ Ejecutando Pre-Scraping Camuflado en la portada de ${fuente.nombre}...`);
    
    // Primero, ataque invisible (simulando un iPhone)
    let htmlPortada = await burlarCortafuegos(fuente.url);
    
    // Si falla, sacamos a los Proxies (CodeTabs o Universal)
    if (!htmlPortada) {
        console.log(`   ⚠️ Camuflaje falló. Cayendo a proxies...`);
        if (["BOC_CANTABRIA", "BOR"].includes(fuente.nombre)) {
            const nativo = await obtenerTextoNativo(fuente.url, true);
            htmlPortada = nativo ? nativo.texto : null;
        } else {
            htmlPortada = await obtenerTextoUniversal(fuente.url);
        }
    }
    
    if (!htmlPortada) return null;

    // 1. Cantabria (BOC): Buscamos el parámetro matemático
    if (fuente.nombre === "BOC_CANTABRIA") {
        const match = htmlPortada.match(/idBoletin=(\d+)/);
        return match ? `https://boc.cantabria.es/boces/verBoletin.do?idBoletin=${match[1]}` : null;
    }

    // 2. La Rioja (BOR): Buscamos el parámetro matemático
    if (fuente.nombre === "BOR") {
        const match = htmlPortada.match(/bor-boletin\?id=(\d+)/);
        return match ? `https://web.larioja.org/bor-boletin?id=${match[1]}` : null;
    }

    // 3. Melilla (BOME): Melilla a veces pone la URL con comillas simples o dobles
    if (fuente.nombre === "BOME") {
        const match = htmlPortada.match(/(?:href|src)=["']([^"']*\.pdf)["']/i); 
        let link = match ? match[1] : null;
        if (link && !link.startsWith('http')) link = "https://bomemelilla.es/" + link.replace(/^\/+/, '');
        return link;
    }

    // 4. Ceuta (BOCCE): Ceuta esconde los PDFs en un iframe o tabla, quitamos el requisito de que se llame "bocce"
    if (fuente.nombre === "BOCCE") {
        const match = htmlPortada.match(/(?:href|src)=["']([^"']*\.pdf)["']/i);
        let link = match ? match[1] : null;
        
        // Evitamos coger el PDF de "Reclamaciones Consejo Transparencia"
        if (link && link.toLowerCase().includes('transparencia')) return null;

        if (link && !link.startsWith('http')) link = "https://www.ceuta.es/" + link.replace(/^\/+/, '');
        return link;
    }

    return fuente.url;
}

module.exports = { obtenerUrlDelDia };