require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { OpenAI } = require("openai");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function obtenerTurnoIA(titulo) {
  const prompt = `
  Clasifica el turno de acceso de esta convocatoria de empleo público basándote en su título.
  TÍTULO: ${titulo}

  REGLAS:
  - "Promoción Interna": Si el título menciona promoción interna, promoción cruzada, o provisión de puestos entre funcionarios.
  - "Discapacidad": Si menciona cupo de reserva para discapacidad o diversidad funcional.
  - "Turno Libre": Si dice turno libre, acceso libre, o NO menciona explícitamente promoción interna ni discapacidad (es el valor por defecto).
  `;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.0,
      messages: [
        { role: "system", content: "Devuelve ÚNICAMENTE un JSON con la propiedad 'turno'." },
        { role: "user", content: prompt }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "turno_schema",
          strict: true,
          schema: {
            type: "object",
            properties: {
              turno: { 
                type: "string",
                enum: ["Turno Libre", "Promoción Interna", "Discapacidad"]
              }
            },
            required: ["turno"],
            additionalProperties: false
          }
        }
      }
    });
    return JSON.parse(response.choices[0].message.content).turno;
  } catch (error) {
    console.error(`  ❌ Error de IA: ${error.message}`);
    return "Turno Libre"; // Fallback de seguridad
  }
}

async function ejecutarBackfillTurnos() {
  console.log("🚀 Iniciando Backfill de Turnos...");

  // Obtenemos las convocatorias que NO tienen turno asignado
  const { data: convocatorias, error } = await supabase
    .from('convocatorias')
    .select('id, slug, title')
    .is('turno', null);

  if (error) {
    console.error("❌ Error conectando a Supabase:", error);
    return;
  }

  console.log(`✅ Se han encontrado ${convocatorias.length} registros sin turno.`);

  let actualizadas = 0;

  for (let i = 0; i < convocatorias.length; i++) {
    const item = convocatorias[i];
    console.log(`\n⏳ [${i + 1}/${convocatorias.length}] Analizando: ${item.title.substring(0, 60)}...`);

    const turnoAsignado = await obtenerTurnoIA(item.title);

    const { error: updateError } = await supabase
      .from('convocatorias')
      .update({ turno: turnoAsignado })
      .eq('id', item.id);

    if (updateError) {
      console.error(`  ❌ Error BD al actualizar ${item.slug}:`, updateError.message);
    } else {
      console.log(`  ✅ Asignado a: [${turnoAsignado}]`);
      actualizadas++;
    }

    // Pausa pequeñita para no saturar la API
    await esperar(300); 
  }

  console.log(`\n🎉 BACKFILL COMPLETADO. Se han asignado turnos a ${actualizadas} registros con éxito.`);
}

ejecutarBackfillTurnos();