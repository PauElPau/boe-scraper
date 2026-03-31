const { obtenerTextoNativo, obtenerTextoUniversal } = require('./scraper');

// 🎯 FASE PREVIA: Entra a las portadas "caja fuerte" y extrae la URL real del último boletín
async function obtenerUrlDelDia(fuente) {
    // 1. Cataluña (DOGC): Solo devuelve un flag para que el engine sepa que debe usar la API
    if (fuente.nombre === "DOGC") {
        return "API_REST";
    }

    console.log(`   🕵️‍♂️ Ejecutando Pre-Scraping en la portada de ${fuente.nombre}...`);
    
    let htmlPortada = null;
    
    // 🛡️ Bypasseamos el cortafuegos de estas comunidades usando CodeTabs de forma explícita
    if (["BOC_CANTABRIA", "BOR"].includes(fuente.nombre)) {
        const nativo = await obtenerTextoNativo(fuente.url, true);
        htmlPortada = nativo ? nativo.texto : null;
    } else {
        htmlPortada = await obtenerTextoUniversal(fuente.url);
    }
    
    if (!htmlPortada) return null;

    // 2. Cantabria (BOC): Busca matemáticamente el ID
    if (fuente.nombre === "BOC_CANTABRIA") {
        const match = htmlPortada.match(/idBoletin=(\d+)/);
        return match ? `https://boc.cantabria.es/boces/verBoletin.do?idBoletin=${match[1]}` : null;
    }

    // 3. La Rioja (BOR): Busca matemáticamente el ID
    if (fuente.nombre === "BOR") {
        const match = htmlPortada.match(/bor-boletin\?id=(\d+)/);
        return match ? `https://web.larioja.org/bor-boletin?id=${match[1]}` : null;
    }

    // 4. Melilla (BOME): Atrapa el primer PDF real de la tabla principal
    if (fuente.nombre === "BOME") {
        const match = htmlPortada.match(/href="([^"]*\.pdf)"/i); 
        let link = match ? match[1] : null;
        if (link && !link.startsWith('http')) link = "https://bomemelilla.es/" + link.replace(/^\/+/, '');
        return link;
    }

    // 5. Ceuta (BOCCE): Atrapa el PDF que esté dentro de su carpeta oficial de boletines
    if (fuente.nombre === "BOCCE") {
        const match = htmlPortada.match(/href="([^"]*\/bocce\/[^"]*\.pdf)"/i);
        let link = match ? match[1] : null;
        if (link && !link.startsWith('http')) link = "https://www.ceuta.es/" + link.replace(/^\/+/, '');
        return link;
    }

    return fuente.url;
}

module.exports = { obtenerUrlDelDia };