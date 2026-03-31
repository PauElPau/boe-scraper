const { obtenerTextoUniversal } = require('./scraper');

// 🕵️‍♂️ FASE PREVIA: Entra a las portadas "caja fuerte" y extrae la URL real de hoy
async function obtenerUrlDelDia(fuente) {
    const hoy = new Date();
    const dd = String(hoy.getDate()).padStart(2, '0');
    const mm = String(hoy.getMonth() + 1).padStart(2, '0');
    const yyyy = hoy.getFullYear();

    // 1. Cataluña (DOGC): Solo necesita inyectar la fecha de hoy en la URL
    if (fuente.nombre === "DOGC") {
        return fuente.url.replace('{DD/MM/YYYY}', `${dd}/${mm}/${yyyy}`);
    }

    // Para las demás, descargamos la portada y buscamos el enlace de hoy
    console.log(`   🕵️‍♂️ Ejecutando Pre-Scraping en la portada de ${fuente.nombre}...`);
    const htmlPortada = await obtenerTextoUniversal(fuente.url);
    if (!htmlPortada) return null;

    // 2. Cantabria (BOC): Buscamos el ID del último boletín
    if (fuente.nombre === "BOC_CANTABRIA") {
        const match = htmlPortada.match(/verBoletin\.do\?idBoletin=\d+/);
        return match ? `https://boc.cantabria.es/boces/${match[0]}` : null;
    }

    // 3. La Rioja (BOR): Buscamos el enlace a bor-boletin?id=...
    if (fuente.nombre === "BOR") {
        const match = htmlPortada.match(/href="([^"]*bor-boletin\?id=[^"]+)"/);
        return match ? `https://web.larioja.org${match[1]}` : null;
    }

    // 4. Melilla (BOME): Buscamos el PDF o HTML que coincida con la fecha de hoy
    if (fuente.nombre === "BOME") {
        const regexHoy = new RegExp(`href="([^"]*${yyyy}-?${mm}-?${dd}[^"]*)"`, 'i');
        const match = htmlPortada.match(regexHoy) || htmlPortada.match(/href="([^"]*\.pdf)"/i); // Fallback al último PDF
        let link = match ? match[1] : null;
        if (link && !link.startsWith('http')) link = "https://bomemelilla.es" + (link.startsWith('/') ? '' : '/') + link;
        return link;
    }

    // 5. Ceuta (BOCCE): Buscamos un enlace que contenga la fecha de hoy
    if (fuente.nombre === "BOCCE") {
        const regexHoy = new RegExp(`href="([^"]*${dd}-${mm}-${yyyy}[^"]*)"`, 'i');
        const match = htmlPortada.match(regexHoy) || htmlPortada.match(/href="([^"]*bocce[^"]*\.pdf)"/i);
        let link = match ? match[1] : null;
        if (link && !link.startsWith('http')) link = "https://www.ceuta.es" + (link.startsWith('/') ? '' : '/') + link;
        return link;
    }

    return fuente.url;
}

module.exports = { obtenerUrlDelDia };