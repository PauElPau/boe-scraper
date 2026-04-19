// ==========================================
// ARCHIVO: scripts/recalcular-fechas.js
// ==========================================

require("./config/env");
const { supabase } = require("./services/db");
const { calcularFechaCierre } = require("./utils/helpers");

async function recalcularFechasBD() {
  console.log("🔄 Iniciando recálculo masivo de fechas de cierre...");
  let actualizados = 0;
  let procesados = 0;

  try {
    // 1. Extraemos SOLO las convocatorias que tienen un plazo definido
    // Traemos los datos clave para recalcular
    const { data: convocatorias, error } = await supabase
      .from('convocatorias')
      .select('id, slug, publication_date, plazo_numero, plazo_tipo, provincia, fecha_cierre')
      .not('plazo_numero', 'is', null)
      .not('plazo_tipo', 'is', null);

    if (error) throw new Error(error.message);

    console.log(`📊 Se encontraron ${convocatorias.length} convocatorias con plazos. Analizando discrepancias...`);

    // 2. Iteramos y recalculamos
    for (const conv of convocatorias) {
      procesados++;
      
      // Usamos tu super-función vitaminada con la provincia
      const nuevaFecha = calcularFechaCierre(
        conv.publication_date, 
        conv.plazo_numero, 
        conv.plazo_tipo, 
        conv.provincia
      );

      // 3. Si la nueva fecha es válida y es distinta a la que hay en BD, actualizamos
      if (nuevaFecha && nuevaFecha !== conv.fecha_cierre) {
        console.log(`📝 Actualizando [${conv.slug.substring(0, 30)}...]: ${conv.fecha_cierre} -> ${nuevaFecha}`);
        
        const { error: updateError } = await supabase
          .from('convocatorias')
          .update({ fecha_cierre: nuevaFecha })
          .eq('id', conv.id);

        if (updateError) {
          console.error(`   ❌ Error en update:`, updateError.message);
        } else {
          actualizados++;
        }
      }
    }

    console.log(`\n🎉 PROCESO COMPLETADO.`);
    console.log(`👉 Total analizadas: ${procesados}`);
    console.log(`👉 Total actualizadas (corregidas): ${actualizados}`);
    process.exit(0); // Salida limpia para GitHub Actions

  } catch (error) {
    console.error("🔥 Error crítico en el recálculo:", error);
    process.exit(1); // Salida con error
  }
}

recalcularFechasBD();