require("../config/env");
const { extraerBoletines } = require("./engine");

// Ejecutamos la función asíncrona y forzamos el cierre de Node al terminar
extraerBoletines()
  .then(() => {
    console.log("🛑 Todos los procesos finalizados. Cerrando la madriguera...");
    process.exit(0); // 0 = Salida exitosa
  })
  .catch((error) => {
    console.error("🔥 Error crítico no controlado. Cerrando con error:", error);
    process.exit(1); // 1 = Salida con error (para que GitHub Actions avise)
  });