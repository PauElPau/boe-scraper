const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ==========================================
// 📅 MOTOR DE CALENDARIO Y FESTIVOS (AÑO 2026)
// ==========================================

const FESTIVOS = {
  // 🇪🇸 Festivos Nacionales Inamovibles (Comunes a toda España)
  "Estatal": [
    '01-01', // Año Nuevo
    '01-06', // Epifanía del Señor / Reyes
    '04-03', // Viernes Santo (2026)
    '05-01', // Fiesta del Trabajo
    '08-15', // Asunción de la Virgen
    '10-12', // Fiesta Nacional de España
    '12-08', // Inmaculada Concepción
    '12-25'  // Natividad del Señor
  ],

  // 📍 Festivos Autonómicos (Incluye Jueves Santo, Lunes de Pascua y traslados de domingos a lunes)
  "Andalucía": ['02-28', '04-02', '11-02', '12-07'], 
  "Aragón": ['04-02', '04-23', '11-02', '12-07'],
  "Asturias": ['04-02', '09-08', '11-02', '12-07'],
  "Islas Baleares": ['03-02', '04-02', '04-06', '12-26'], // Día de Baleares pasa al 2 de marzo
  "Canarias": ['04-02', '05-30', '11-02', '12-07'], 
  "Cantabria": ['04-02', '07-28', '09-15'], 
  "Castilla-La Mancha": ['04-02', '06-04', '11-02', '12-07'], // 4 de junio (Corpus Christi)
  "Castilla y León": ['04-02', '04-23', '11-02', '12-07'],
  "Cataluña": ['04-06', '06-24', '09-11', '12-26'], // Lunes de Pascua, Sant Joan, Diada, Sant Esteve
  "Comunidad Valenciana": ['03-19', '04-06', '06-24', '10-09'], // San José, Lunes Pascua, San Juan, Día CV
  "Extremadura": ['04-02', '09-08', '11-02', '12-07'],
  "Galicia": ['04-02', '05-18', '07-25'], // Letras Gallegas pasa al 18 de mayo, Día de Galicia
  "Madrid": ['04-02', '05-02', '11-02', '12-07'], // Día de la Comunidad de Madrid
  "Región de Murcia": ['03-19', '04-02', '06-09', '11-02'], // San José, Día de la Región
  "Navarra": ['04-02', '04-06', '07-25', '12-03'], // San Francisco Javier
  "País Vasco": ['04-02', '04-06', '07-25'], // Santiago Apóstol
  "La Rioja": ['04-02', '04-06', '06-09'], // Día de La Rioja
  "Ceuta": ['04-02', '08-05', '09-02'],
  "Melilla": ['04-02', '09-17']
};
// 🗺️ MAPA DE PROVINCIAS A COMUNIDADES AUTÓNOMAS
const PROVINCIA_TO_CCAA = {
  'Almería': 'Andalucía', 'Cádiz': 'Andalucía', 'Córdoba': 'Andalucía', 'Granada': 'Andalucía', 'Huelva': 'Andalucía', 'Jaén': 'Andalucía', 'Málaga': 'Andalucía', 'Sevilla': 'Andalucía',
  'Huesca': 'Aragón', 'Teruel': 'Aragón', 'Zaragoza': 'Aragón',
  'Asturias': 'Asturias',
  'Baleares': 'Islas Baleares',
  'Las Palmas': 'Canarias', 'Santa Cruz de Tenerife': 'Canarias',
  'Cantabria': 'Cantabria',
  'Albacete': 'Castilla-La Mancha', 'Ciudad Real': 'Castilla-La Mancha', 'Cuenca': 'Castilla-La Mancha', 'Guadalajara': 'Castilla-La Mancha', 'Toledo': 'Castilla-La Mancha',
  'Ávila': 'Castilla y León', 'Burgos': 'Castilla y León', 'León': 'Castilla y León', 'Palencia': 'Castilla y León', 'Salamanca': 'Castilla y León', 'Segovia': 'Castilla y León', 'Soria': 'Castilla y León', 'Valladolid': 'Castilla y León', 'Zamora': 'Castilla y León',
  'Barcelona': 'Cataluña', 'Girona': 'Cataluña', 'Lleida': 'Cataluña', 'Tarragona': 'Cataluña',
  'Alicante': 'Comunidad Valenciana', 'Castellón': 'Comunidad Valenciana', 'Valencia': 'Comunidad Valenciana',
  'Badajoz': 'Extremadura', 'Cáceres': 'Extremadura',
  'A Coruña': 'Galicia', 'Lugo': 'Galicia', 'Ourense': 'Galicia', 'Pontevedra': 'Galicia',
  'Madrid': 'Madrid',
  'Murcia': 'Región de Murcia',
  'Navarra': 'Navarra',
  'Álava': 'País Vasco', 'Gipuzkoa': 'País Vasco', 'Vizcaya': 'País Vasco',
  'La Rioja': 'La Rioja',
  'Ceuta': 'Ceuta',
  'Melilla': 'Melilla',
  'Estatal': 'Estatal' // Por si la plaza es puramente de un Ministerio
};

// 🛡️ Helper interno para comprobar si un día es festivo
function esDiaFestivo(fechaObj, region) {
  const mes = String(fechaObj.getMonth() + 1).padStart(2, '0');
  const dia = String(fechaObj.getDate()).padStart(2, '0');
  const mmdd = `${mes}-${dia}`;

  // 1. ¿Es festivo en toda España?
  if (FESTIVOS["Estatal"].includes(mmdd)) return true;

  // 2. ¿Es festivo en la comunidad autónoma de esta plaza?
  if (region && FESTIVOS[region] && FESTIVOS[region].includes(mmdd)) {
    return true;
  }

  return false;
}

// ⏱️ CÁLCULO DE FECHA DE CIERRE (Ahora recibe la provincia)
function calcularFechaCierre(fechaPublicacion, plazoNumero, plazoTipo, provincia = null) {
  if (!plazoNumero || !plazoTipo || !fechaPublicacion) return null;
  
  // Traducimos la provincia a su Comunidad Autónoma (Si no hay provincia, usamos null)
  const region = provincia ? PROVINCIA_TO_CCAA[provincia] : null;

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
        
        const esFinDeSemana = (diaSemana === 0 || diaSemana === 6);
        // Le pasamos la 'region' ya traducida
        const esFestivo = esDiaFestivo(fechaCierre, region);

        if (!esFinDeSemana && !esFestivo) {
          diasSumados++; 
        }
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
  const accionTribunal = t.includes('nombramiento') || t.includes('nombra ') || t.includes('designación') || t.includes('designa ') || t.includes('composición') || t.includes('modificación');
  const esTribunal = t.includes('tribunal') || t.includes('comisión de selección') || t.includes('comisión de valoración') || t.includes('órgano de selección');
  const esRecurso = t.includes('trámite de audiencia') || t.includes('tramite de audiencia') || 
                    t.includes('recurso potestativo') || t.includes('recurso de reposición') || t.includes('recurso de reposicion') ||
                    t.includes('recurso contencioso') || t.includes('recurso de alzada') ||
                    t.includes('recurso extraordinario') || t.includes('interposición de recurso');
  const esNombramientoTribunal = accionTribunal && esTribunal;
  const esRuido = t.includes('convenio') || t.includes('subvención') || t.includes('subvenciones') || 
                  t.includes('licitación') || t.includes('adjudicación de contrato') || 
                  t.includes('impacto ambiental') || 
                  t.includes('ayudas ') || t.includes('ayuda a la ') || t.includes('solicitud de ayuda') || t.includes('solicitud de la ayuda') || 
                  t.includes('concesión de ayudas') ||
                  t.includes('contrato titulado') || t.includes('contrato de relevo') || 
                  t.includes('proyectos específicos de i+d') || t.includes('proyectos de investigación') || 
                  t.includes('residencias juveniles') || 
                  t.includes('beca') || t.includes('premio') || 
                  t.includes('suministro') || t.includes('se emplaza') || t.includes('emplazamiento') || 
                  t.includes('licencia ambiental') || t.includes('viviendas de protección') || 
                  t.includes('suplentes temporales') || t.includes('impuesto') || 
                  t.includes('pago voluntario') || t.includes('liquidaciones');
  return esCese || esNombramientoTribunal || esRecurso || esRuido;
}



module.exports = {
  esperar,
  calcularFechaCierre,
  capitalizarProfesion,
  limpiarCodificacion,
  esTramiteBasura
};
