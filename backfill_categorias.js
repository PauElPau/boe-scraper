require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { OpenAI } = require("openai");

// Inicializamos Supabase y OpenAI
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function obtenerCategoriaIA(titulo, profesion, departamento) {
  const prompt = `
  Clasifica esta oferta de empleo público en UNA de las categorías permitidas.
  TÍTULO: ${titulo}
  PROFESIÓN DETECTADA: ${profesion || 'Ninguna'}
  DEPARTAMENTO: ${departamento || 'Ninguno'}
  `;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.0,
      messages: [
        { 
          role: "system", 
          content: "Eres un clasificador estricto. Devuelve únicamente un JSON con la propiedad 'categoria'." 
        },
        { role: "user", content: prompt }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "categoria_schema",
          strict: true,
          schema: {
            type: "object",
            properties: {
              categoria: { 
                type: ["string", "null"], 
                enum: [
                  'Administración General', 
                  'Economía, Hacienda y Finanzas', 
                  'Sanidad y Salud', 
                  'Cuerpos de Seguridad y Emergencias', 
                  'Educación y Docencia', 
                  'Informática y Telecomunicaciones', 
                  'Ingeniería, Arquitectura y Medio Ambiente', 
                  'Justicia y Legislación', 
                  'Trabajo Social y Cuidados', 
                  'Cultura, Archivos y Deportes', 
                  'Oficios y Mantenimiento', 
                  'Otros', 
                  null
                ] 
              }
            },
            required: ["categoria"],
            additionalProperties: false
          }
        }
      }
    });
    return JSON.parse(response.choices[0].message.content).categoria;
  } catch (error) {
    console.error(`  ❌ Error de IA: ${error.message}`);
    return null;
  }
}

async function ejecutarBackfill() {
  console.log("🚀 Iniciando Backfill de Categorías...");

  // 1. Obtenemos todas las convocatorias que NO tienen categoría asignada
  const { data: convocatorias, error } = await supabase
    .from('convocatorias')
    .select('slug, title, profesion, department')
    .is('categoria', null);

  if (error) {
    console.error("❌ Error conectando a Supabase:", error);
    return;
  }

  console.log(`✅ Se han encontrado ${convocatorias.length} registros sin categorizar.`);

  let actualizadas = 0;

  // 2. Iteramos sobre cada una de ellas
  for (let i = 0; i < convocatorias.length; i++) {
    const item = convocatorias[i];
    console.log(`\n⏳ [${i + 1}/${convocatorias.length}] Analizando: ${item.title.substring(0, 60)}...`);

    const categoria = await obtenerCategoriaIA(item.title, item.profesion, item.department);

    if (categoria) {
      // 3. Actualizamos el registro en la Base de Datos
      const { error: updateError } = await supabase
        .from('convocatorias')
        .update({ categoria: categoria })
        .eq('slug', item.slug);

      if (updateError) {
        console.error(`  ❌ Error al actualizar ${item.slug}:`, updateError.message);
      } else {
        console.log(`  ✅ Asignada a: [${categoria}]`);
        actualizadas++;
      }
    } else {
      console.log(`  ⚠️ La IA devolvió null o falló.`);
    }

    // Pequeña pausa para no saturar la API de OpenAI
    await esperar(500); 
  }

  console.log(`\n🎉 BACKFILL COMPLETADO. Se han categorizado ${actualizadas} registros con éxito.`);
}

ejecutarBackfill();