const { obtenerTextoUniversal } = require('./scraper');

// 🕵️‍♂️ FETCH INVISIBLE: Simula un navegador Chrome 100% real para esquivar WAFs (Error 422/403)
async function fetchInvisible(url) {
    try {
        const res = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
                "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
                "Cache-Control": "max-age=0",
                "Upgrade-Insecure-Requests": "1",
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "none",
                "Sec-Fetch-User": "?1"
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
    if (fuente.nombre === "DOGC") {
        return "https://dogc.gencat.cat/es/pdogc_canals_interns/pdogc_sumari_del_dogc/?seccio=2";
    }

    console.log(`   🕵️‍♂️ Ejecutando Pre-Scraping Invisible en la portada de ${fuente.nombre}...`);
    
    let htmlPortada = await fetchInvisible(fuente.url);
    if (!htmlPortada) {
        console.log(`   ⚠️ Fetch Invisible falló. Cayendo a proxies universales...`);
        htmlPortada = await obtenerTextoUniversal(fuente.url);
    }
    
    if (!htmlPortada) return null;

    // 2. Cantabria (BOC): Busca solo el parámetro ID matemáticamente (inmune a proxies)
    if (fuente.nombre === "BOC_CANTABRIA") {
        const match = htmlPortada.match(/idBoletin=(\d+)/);
        return match ? `https://boc.cantabria.es/boces/verBoletin.do?idBoletin=${match[1]}` : null;
    }

    // 3. La Rioja (BOR): Busca solo el ID numérico del boletín (inmune a proxies)
    if (fuente.nombre === "BOR") {
        const match = htmlPortada.match(/bor-boletin\?id=(\d+)/);
        return match ? `https://web.larioja.org/bor-boletin?id=${match[1]}` : null;
    }

    // 4. Melilla (BOME): Busca cualquier PDF que contenga la palabra BOME
    if (fuente.nombre === "BOME") {
        const match = htmlPortada.match(/([^"'>\s]*BOME[^"'>\s]*\.pdf)/i); 
        let link = match ? match[1] : null;
        if (link && !link.startsWith('http')) link = "https://bomemelilla.es/" + link.replace(/^\/+/, '');
        return link;
    }

    // 5. Ceuta (BOCCE): Busca cualquier PDF que contenga la palabra BOCCE
    if (fuente.nombre === "BOCCE") {
        const match = htmlPortada.match(/([^"'>\s]*(?:bocce|BOCCE)[^"'>\s]*\.pdf)/i);
        let link = match ? match[1] : null;
        if (link && !link.startsWith('http')) link = "https://www.ceuta.es/" + link.replace(/^\/+/, '');
        return link;
    }

    return fuente.url;
}

module.exports = { obtenerUrlDelDia };