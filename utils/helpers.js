const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function calcularFechaCierre(fechaPublicacion, plazoNumero, plazoTipo) {
  if (!plazoNumero || !plazoTipo || !fechaPublicacion) return null;
  const fechaBase = new Date(fechaPublicacion);
  fechaBase.setDate(fechaBase.getDate() + 1);
  let fechaCierre = new Date(fechaBase);
  const tipo = plazoTipo.toLowerCase();
  try {
    if (tipo.includes('hábil') || tipo.includes('habil')) {
      let diasSumados = 0;
      fechaCierre.setDate(fechaCierre.getDate() - 1); 
      while (diasSumados < plazoNumero) {
        fechaCierre.setDate(fechaCierre.getDate() + 1);
        const diaSemana = fechaCierre.getDay();
        if (diaSemana !== 0 && diaSemana !== 6) diasSumados++;
      }
    } 
    else if (tipo.includes('natural') || tipo.includes('día') || tipo.includes('dia')) {
      fechaCierre.setDate(fechaCierre.getDate() + plazoNumero - 1);
    } 
    else if (tipo.includes('mes')) {
      fechaCierre.setMonth(fechaCierre.getMonth() + plazoNumero);
      fechaCierre.setDate(fechaCierre.getDate() - 1); 
    } 
    else return null;
    return fechaCierre.toISOString().split('T')[0];
  } catch (error) { return null; }
}

// 🧹 Helper para formatear profesiones a Title Case (Primera Letra Mayúscula)
function capitalizarProfesion(str) {
    if (!str) return str;
    const palabrasMenores = ['y', 'e', 'o', 'u', 'de', 'del', 'al', 'en', 'por', 'para', 'con', 'sin', 'a', 'las', 'los', 'la', 'el', 'un', 'una'];
    return str.toLowerCase().split(/\s+/).map((word, index) => {
        // Mantenemos en minúscula las palabras menores, salvo que sean la primera palabra
        if (index > 0 && palabrasMenores.includes(word)) {
            return word;
        }
        return word.charAt(0).toUpperCase() + word.slice(1);
    }).join(' ');
}

function limpiarCodificacion(texto) {
  if (!texto) return texto;
  let limpio = texto.replace(/\\u([\dA-Fa-f]{4})/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
  return limpio.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}

// 🛡️ ESCUDO PRE-FILTRADO: Detecta basura administrativa por el título
function esTramiteBasura(titulo) {
  if (!titulo) return false;
  const t = titulo.toLowerCase();

  const esCese = t.includes('cese') || t.includes('jubilación') || t.includes('jubilacion') || t.includes('renuncia');
  const accionTribunal = t.includes('nombramiento') || t.includes('designación') || t.includes('composición') || t.includes('modificación');
  const esTribunal = t.includes('tribunal') || t.includes('comisión de selección') || t.includes('comisión de valoración') || t.includes('órgano de selección');
  const esNombramientoTribunal = accionTribunal && esTribunal;
  const esRuido = t.includes('convenio') || t.includes('subvención') || t.includes('subvenciones') || 
                  t.includes('licitación') || t.includes('adjudicación de contrato') || 
                  t.includes('impacto ambiental') || t.includes('ayudas destinadas') || 
                  t.includes('ayudas al') || t.includes('ayudas para') || t.includes('concesión de ayudas') ||
                  t.includes('contrato titulado') || t.includes('contrato de relevo') || 
                  t.includes('beca') || t.includes('premio') || 
                  t.includes('suministro') || t.includes('se emplaza') || t.includes('emplazamiento') || 
                  t.includes('recurso contencioso') || t.includes('recurso de alzada') ||
                  t.includes('licencia ambiental') || t.includes('viviendas de protección') || 
                  t.includes('suplentes temporales') || t.includes('impuesto') || 
                  t.includes('pago voluntario') || t.includes('liquidaciones');
  return esCese || esNombramientoTribunal || esRuido;
}



module.exports = {
  esperar,
  calcularFechaCierre,
  capitalizarProfesion,
  limpiarCodificacion,
  esTramiteBasura
};
