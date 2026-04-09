require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { OpenAI } = require("openai");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function traducirTitulos() {
  console.log("🚀 Iniciando traductor de titulaciones...");

  // Traemos todas las convocatorias que no sean nulas en titulación
  const { data: convocatorias, error } = await supabase
    .from('convocatorias')
    .select('id, slug, titulacion')
    .not('titulacion', 'is', null);

  if (error) return console.error(error);

  // Expresiones regulares sencillas para detectar si está en catalán/valenciano
  const esCatalan = (texto) => /títol|grau|tècnic|bé|formació/i.test(texto);
  
  const afectadas = convocatorias.filter(c => esCatalan(c.titulacion));
  console.log(`🔎 Encontradas ${afectadas.length} titulaciones sospechosas de estar en otro idioma.`);

  for (const item of afectadas) {
    console.log(`Traduciendo: ${item.titulacion}`);
    
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [
          { role: "system", content: "Traduce el siguiente texto de requisitos académicos al español de España (Castellano). Mantén la concisión. No añadas nada más." },
          { role: "user", content: item.titulacion }
        ]
      });
      
      const traduccion = response.choices[0].message.content.trim();
      
      await supabase.from('convocatorias').update({ titulacion: traduccion }).eq('id', item.id);
      console.log(`✅ Resultado: ${traduccion}\n`);
      
    } catch(e) {
      console.error("Error traduciendo:", e.message);
    }
  }
  console.log("🎉 Limpieza terminada.");
}

traducirTitulos();