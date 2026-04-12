// ==========================================
// ARCHIVO: ./reprocesar.js
// ==========================================

require("dotenv").config(); // Importante para GitHub Actions
const { supabase } = require("./services/db");
const { analizarConvocatoriaIA } = require("./services/ai");
const { esperar, calcularFechaCierre, limpiarCodificacion, capitalizarProfesion } = require("./utils/helpers");

async function reprocesar() {
    console.log("🚀 Iniciando reprocesado con IA (Matriz 3D)...");

    // 1. Obtener las convocatorias a reprocesar.
    // ⚠️ LÍMITE DE SEGURIDAD: Solo cogerá las 50 más recientes para probar. 
    // Cuando veas que funciona bien, cambia el .limit(50) por .limit(2000) o bórralo.
    const { data: convocatorias, error } = await supabase
        .from("convocatorias")
        .select("*")
        .is("fase", null) // 👈 ¡AÑADE ESTA LÍNEA!
        .order("created_at", { ascending: false })
        .limit(600); // Puedes dejar o quitar el límite según prefieras

    if (error) {
        console.error("❌ Error al conectar con Supabase:", error);
        process.exit(1);
    }

    console.log(`📦 Se van a reprocesar ${convocatorias.length} convocatorias.`);

    let procesadas = 0;
    let errores = 0;

    // 2. Bucle secuencial para no saturar la API
    for (let i = 0; i < convocatorias.length; i++) {
        const conv = convocatorias[i];
        console.log(`\n⏳ Procesando [${i + 1}/${convocatorias.length}]: ${conv.title.substring(0, 60)}...`);

        if (!conv.raw_text || conv.raw_text.length < 50) {
            console.log("⏭️ Saltando: No hay texto suficiente para analizar.");
            continue;
        }

        try {
            // Mandamos el texto al nuevo "cerebro" de la IA
            const analisisIA = await analizarConvocatoriaIA(
                conv.title,
                conv.raw_text,
                conv.department,
                conv.section,
                conv.provincia // Usamos la provincia actual como ámbito autonómico referencial
            );

            if (analisisIA.tipo === "IGNORAR") {
                console.log("⏭️ La IA ha marcado esta convocatoria como IGNORAR.");
                continue;
            }

            // Limpieza de profesiones
            let profesionPrincipal = (analisisIA.profesiones && analisisIA.profesiones.length > 0) ? analisisIA.profesiones[0] : null;
            profesionPrincipal = capitalizarProfesion(profesionPrincipal);
            const profesionesLimpias = analisisIA.profesiones ? analisisIA.profesiones.map(capitalizarProfesion) : null;

            // Calcular nueva fecha de cierre con los plazos y la fecha original de publicación
            const nuevaFechaCierre = calcularFechaCierre(
                conv.publication_date,
                analisisIA.plazo_numero,
                analisisIA.plazo_tipo
            );

            // Preparar el paquete de actualización con los nuevos campos de la Matriz 3D
            const updateData = {
                type: analisisIA.tipo, // OJO: en BD la columna se sigue llamando 'type'
                fase: analisisIA.fase,
                sistema: analisisIA.sistema,
                turno: analisisIA.turno,
                distribucion_plazas: analisisIA.distribucion_plazas,
                ambito: analisisIA.ambito,
                
                plazas: analisisIA.plazas,
                resumen: limpiarCodificacion(analisisIA.resumen),
                descripcion_extendida: limpiarCodificacion(analisisIA.descripcion_extendida),
                plazo_numero: analisisIA.plazo_numero,
                plazo_tipo: analisisIA.plazo_tipo,
                fecha_cierre: nuevaFechaCierre,
                plazo_texto: (analisisIA.plazo_numero && analisisIA.plazo_tipo) ? `${analisisIA.plazo_numero} días ${analisisIA.plazo_tipo}` : null,
                grupo: analisisIA.grupo,
                profesion: profesionPrincipal,
                profesiones: profesionesLimpias,
                categoria: analisisIA.categoria,
                provincia: analisisIA.provincia,
                titulacion: analisisIA.titulacion,
                tasa: analisisIA.tasa,
                meta_description: limpiarCodificacion(analisisIA.meta_description || (analisisIA.resumen ? analisisIA.resumen.substring(0, 150) + "..." : "Ver detalles."))
            };

            // Inyectar los datos limpios en la base de datos
            const { error: updateError } = await supabase
                .from("convocatorias")
                .update(updateData)
                .eq("id", conv.id);

            if (updateError) {
                console.error("❌ Error al guardar en BD:", updateError.message);
                errores++;
            } else {
                console.log(`✅ OK -> Fase: ${analisisIA.fase} | Turnos: ${analisisIA.turno ? analisisIA.turno.join(', ') : 'Ninguno'}`);
                procesadas++;
            }

        } catch (err) {
            console.error("❌ Error de IA o Red:", err.message);
            errores++;
        }

        // ⏱️ Freno de emergencia: 3 segundos entre llamadas a OpenAI para evitar bloqueos
        await esperar(3000);
    }

    console.log(`\n🎉 REPROCESADO FINALIZADO. Éxitos: ${procesadas} | Errores: ${errores}`);
    process.exit(0);
}

reprocesar();