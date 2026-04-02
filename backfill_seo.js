require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { OpenAI } = require("openai");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function redactarArticuloSEO(titulo, departamento, provincia, textoBruto) {
  const prompt = `
  Eres un redactor SEO experto en empleo público.
  TÍTULO: ${titulo}
  ORGANISMO: ${departamento || 'No especificado'}
  PROVINCIA: ${provincia || 'No especificada'}
  TEXTO OFICIAL: ${textoBruto ? textoBruto.substring(0, 8000) : 'Sin texto'}

  🚀 REGLA CRÍTICA: Escribe un artículo completo de AL MENOS 300 PALABRAS estructurado en formato Markdown sobre esta oferta de empleo.
  
  ESTRUCTURA OBLIGATORIA DEL TEXTO EN MARKDOWN:
  1. Introducción atractiva (Usa un H2 ##): Habla sobre la oportunidad de conseguir este puesto en [Organismo] y [Provincia].
  2. Requisitos y Titulación (Usa H3 ### y viñetas -): Explica quién puede presentarse de forma coloquial.
  3. Proceso Selectivo (Usa H3 ###): Resume si es concurso, oposición, qué fases tiene o cómo se va a evaluar.
  4. Plazos y Presentación (Usa H3 ###): Explica cómo y dónde presentar la instancia.
  
  El texto debe sonar natural, animando al opositor y repitiendo palabras clave como "oposiciones", "empleo público", "trabajar en", el nombre de la profesión y la provincia.
  `;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2, // Un poco más creativo para redactar
      messages: [
        { role: "system", content: "Devuelve ÚNICAMENTE un JSON con la propiedad 'descripcion_extendida'." },
        { role: "user", content: prompt }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "seo_schema",
          strict: true,
          schema: {
            type: "object",
            properties: {
              descripcion_extendida: { type: "string" }
            },
            required: ["descripcion_extendida"],
            additionalProperties: false
          }
        }
      }
    });
    return JSON.parse(response.choices[0].message.content).descripcion_extendida;
  } catch (error) {
    if (error.status === 429) {
        console.warn(`   ⏳ Límite de IA (429). Esperando 10s...`);
        await esperar(10000);
        return redactarArticuloSEO(titulo, departamento, provincia, textoBruto);
    }
    console.error(`  ❌ Error de IA: ${error.message}`);
    return null;
  }
}

async function ejecutarBackfillSEO() {
  console.log("🚀 Iniciando Backfill SEO para las Oposiciones Reales...");

  // 1. Obtenemos SOLO las convocatorias importantes que tengan texto en bruto
  const { data: convocatorias, error } = await supabase
    .from('convocatorias')
    .select('slug, title, department, provincia, raw_text, descripcion_extendida');

  if (error) {
    console.error("❌ Error conectando a Supabase:", error);
    return;
  }

  // Filtramos contando PALABRAS (separadas por espacios). Si tiene menos de 200 palabras, la consideramos "antigua" y la actualizamos.
  const convocatoriasAActualizar = convocatorias.filter(c => !c.descripcion_extendida || c.descripcion_extendida.split(/\s+/).length < 200);

  console.log(`✅ Se van a generar artículos SEO para ${convocatoriasAActualizar.length} plazas.`);

  let actualizadas = 0;

  // 2. Iteramos generando el contenido
  for (let i = 0; i < convocatoriasAActualizar.length; i++) {
    const item = convocatoriasAActualizar[i];
    console.log(`\n✍️ [${i + 1}/${convocatoriasAActualizar.length}] Redactando: ${item.title.substring(0, 60)}...`);

    const articuloSEO = await redactarArticuloSEO(item.title, item.department, item.provincia, item.raw_text);

    if (articuloSEO && articuloSEO.length > 100) {
      // 3. Actualizamos la BD
      const { error: updateError } = await supabase
        .from('convocatorias')
        .update({ descripcion_extendida: articuloSEO })
        .eq('slug', item.slug);

      if (updateError) {
        console.error(`  ❌ Error BD al actualizar ${item.slug}:`, updateError.message);
      } else {
        console.log(`  ✅ Artículo guardado! (${articuloSEO.split(' ').length} palabras)`);
        actualizadas++;
      }
    } else {
      console.log(`  ⚠️ Fallo al generar texto para este registro.`);
    }

    // Pausa obligatoria para dar respiro a la API de OpenAI (y evitar el Error 429)
    await esperar(1500); 
  }

  console.log(`\n🎉 BACKFILL SEO COMPLETADO. Se han mejorado ${actualizadas} páginas de convocatorias.`);
}

ejecutarBackfillSEO();