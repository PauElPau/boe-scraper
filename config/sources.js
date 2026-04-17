const FUENTES_BOLETINES = [

 // { nombre: "BOJA", tipo: "rss", url: "https://www.juntadeandalucia.es/boja/distribucion/s53.xml", ambito: "Andalucía" },
 // { nombre: "BOPV", tipo: "rss", url: "https://www.euskadi.eus/bopv2/datos/Ultimo.xml", ambito: "País Vasco" },
 // { nombre: "BORM", tipo: "rss", url: "https://www.borm.es/rss/boletin.xml", ambito: "Región de Murcia" },
 // { nombre: "DOE", tipo: "rss", url: "https://doe.juntaex.es/rss/rss.php?seccion=6", ambito: "Extremadura" },
 // { nombre: "DOG", tipo: "rss", url: "https://www.xunta.gal/diario-oficial-galicia/rss/Sumario_es.rss", ambito: "Galicia" },
  { nombre: "BOCM", tipo: "rss", url: "https://www.bocm.es/ultimo-boletin.xml", ambito: "Madrid" },
 // { nombre: "BOA", tipo: "rss", url: "https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI?CMD=RSSLST&DOCS=1-200&BASE=BOLE&SEC=BOARSS&SEPARADOR=&PUBL-C=lafechaxx", ambito: "Aragón" },
  { nombre: "BOC", tipo: "rss", url: "https://www.gobiernodecanarias.org/boc/feeds/capitulo/autoridades_personal_oposiciones.rss", ambito: "Canarias" },  
  
 // { nombre: "DOGV", tipo: "html_directo", url: "https://sede.gva.es/es/novetats-ocupacio-publica?fecha={DD}%2F{MM}%2F{YYYY}", ambito: "Comunidad Valenciana" },
 // { nombre: "DOCM", tipo: "html_directo", url: "https://docm.jccm.es/docm/cambiarBoletin.do?fecha={YYYYMMDD}", ambito: "Castilla-La Mancha" },   
 // { nombre: "BOCYL", tipo: "html_directo", url: "https://bocyl.jcyl.es/boletin.do?fechaBoletin={DD/MM/YYYY}#I.B._AUTORIDADES_Y_PERSONAL", ambito: "Castilla y León" },
 // { nombre: "BON", tipo: "html_directo", url: "https://bon.navarra.es/es/ultimo", ambito: "Navarra" },
  { nombre: "BOIB", tipo: "html_directo", url: "https://www.caib.es/eboibfront/indexrss.do?lang=es", ambito: "Islas Baleares", boibRssToHtml: true },
 // { nombre: "BOPA", tipo: "html_directo", url: "https://sede.asturias.es/ultimos-boletines?p_r_p_summaryLastBopa=true", ambito: "Asturias" },
  { nombre: "DOGC", tipo: "html_directo", url: "API_REST", ambito: "Cataluña"},  
  
  // A REVISAR (Scraping de 2 Fases activado)
  { nombre: "BOC_CANTABRIA", tipo: "html_directo", url: "https://boc.cantabria.es/boces/boletines.do", ambito: "Cantabria", fase_previa: true },
 // { nombre: "BOCCE", tipo: "html_directo", url: "https://www.ceuta.es/ceuta/bocce", ambito: "Ceuta", fase_previa: true },
 // { nombre: "BOME", tipo: "html_directo", url: "https://bomemelilla.es/", ambito: "Melilla", fase_previa: true },
 // { nombre: "BOR", tipo: "html_directo", url: "https://web.larioja.org/bor-portada", ambito: "La Rioja", fase_previa: false },
  
  //POR ULTIMO EJECUTAMOS EL BOE
//  { nombre: "BOE", tipo: "rss", url: "https://www.boe.es/rss/boe.php?s=2B", ambito: "Estatal" }


];

module.exports = {
  FUENTES_BOLETINES
};
