const fs = require('fs');
const path = require('path');

const directoriosARevisar = ['./src', './utils', './config', './services', './core', './.github']; // Añade aquí tus carpetas principales
const archivoSalida = 'proyecto_completo.txt';
let contenidoFinal = '';

function leerDirectorio(dir) {
    if (!fs.existsSync(dir)) return;
    const archivos = fs.readdirSync(dir);
    
    for (const archivo of archivos) {
        const rutaCompleta = path.join(dir, archivo);
        const stat = fs.statSync(rutaCompleta);
        
        if (stat.isDirectory()) {
            leerDirectorio(rutaCompleta); // Busca en subcarpetas
        } else if (rutaCompleta.endsWith('.js') || rutaCompleta.endsWith('.env.example')) {
            const contenido = fs.readFileSync(rutaCompleta, 'utf-8');
            contenidoFinal += `\n// ==========================================\n`;
            contenidoFinal += `// ARCHIVO: ${rutaCompleta}\n`;
            contenidoFinal += `// ==========================================\n\n`;
            contenidoFinal += contenido + '\n\n';
        }
    }
}

// También incluimos el index.js principal
if (fs.existsSync('./index.js')) {
    contenidoFinal += `\n// ==========================================\n// ARCHIVO: ./index.js\n// ==========================================\n\n` + fs.readFileSync('./index.js', 'utf-8') + '\n\n';
}

directoriosARevisar.forEach(leerDirectorio);
fs.writeFileSync(archivoSalida, contenidoFinal);
console.log(`✅ ¡Listo! Todo el código se ha juntado en ${archivoSalida}`);