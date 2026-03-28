const FUENTES_BOLETINES = [
 // { nombre: "BOE", tipo: "rss", url: "https://www.boe.es/rss/boe.php?s=2B", ambito: "Estatal" },
  
  //HTML: https://www.juntadeandalucia.es/boja/2026/60/18.html -> OK
  //PDF: MAL: REVISAR PORQUE ALGUNOS LOS ESTAMOS COGIENDO BIEN Y OTROS NO
 // { nombre: "BOJA", tipo: "rss", url: "https://www.juntadeandalucia.es/boja/distribucion/s53.xml", ambito: "Andalucía" },
  
  //HTML: https://www.euskadi.eus/web01-bopv/es/bopv2/datos/2026/03/2601340a.shtml -> OK
  //PDF: https://www.euskadi.eus/web01-bopv/es/bopv2/datos/2026/03/2601340a.pdf -> MAL: FORMAR A PARTIR DE HTML
 // { nombre: "BOPV", tipo: "rss", url: "https://www.euskadi.eus/bopv2/datos/Ultimo.xml", ambito: "País Vasco" },
  
//  { nombre: "BORM", tipo: "rss", url: "https://www.borm.es/rss/boletin.xml", ambito: "Región de Murcia" },
  
  //HTML: https://doe.juntaex.es/otrosFormatos/html.php?xml=2026050032&anio=2026&doe=600o   --> MAL: FORMAR A PARTIR DE HTML
  //PDF: https://doe.juntaex.es/pdfs/doe/2026/600o/26050032.pdf --> OK
 // { nombre: "DOE", tipo: "rss", url: "https://doe.juntaex.es/rss/rss.php?seccion=6", ambito: "Extremadura" },
  
  //HTML: https://www.xunta.gal/dog/Publicados/2026/20260327/AnuncioG0597-200326-0003_es.html -> OK
  //PDF: https://www.xunta.gal/dog/Publicados/2026/20260327/AnuncioG0597-200326-0003_es.pdf -> MAL: FORMAR A PARTIR DE HTML
 // { nombre: "DOG", tipo: "rss", url: "https://www.xunta.gal/diario-oficial-galicia/rss/Sumario_es.rss", ambito: "Galicia" },
  
   //HTML: OK
   //PDF: OK
  //{ nombre: "BOCM", tipo: "rss", url: "https://www.bocm.es/ultimo-boletin.xml", ambito: "Madrid" },
  
  //HTML: https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI?CMD=VERDOC&BASE=BOLE&SEC=BUSQUEDA_AVANZADA&DOCN=007957047   --> OK
  //PDF: https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI?CMD=VEROBJ&MLKOB=1441581670303&type=pdf  --> MAL: FORMAR A PARTIR DE HTML
 // { nombre: "BOA", tipo: "rss", url: "https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI?CMD=RSSLST&DOCS=1-200&BASE=BOLE&SEC=BOARSS&SEPARADOR=&PUBL-C=lafechaxx", ambito: "Aragón" },
  
   //HTML: OK
   //PDF: OK
 // { nombre: "BOC", tipo: "rss", url: "https://www.gobiernodecanarias.org/boc/feeds/capitulo/autoridades_personal_oposiciones.rss", ambito: "Canarias" },  

  //HTML: https://sede.gva.es/es/detall-ocupacio-publica?id_emp=110893&id_info=info_basica --> OK
  //PDF: https://sede.gva.es/es/detall-ocupacio-publica?p_p_id=es_gva_es_siac_portlet_SiacDetalleEmpleoPublicoNuevoGVA&p_p_lifecycle=2&p_p_state=normal&p_p_mode=view&p_p_cacheability=cacheLevelPage&_es_gva_es_siac_portlet_SiacDetalleEmpleoPublicoNuevoGVA_accion=pdf&_es_gva_es_siac_portlet_SiacDetalleEmpleoPublicoNuevoGVA_codigo=110893  --> MAL: FORMAR A PARTIR DE HTML
  //{ nombre: "DOGV", tipo: "html_directo", url: "https://sede.gva.es/es/novetats-ocupacio-publica?fecha={DD}%2F{MM}%2F{YYYY}", ambito: "Comunidad Valenciana" },
  
  // como pdf tenemos: https://docm.jccm.es/./descargarArchivo.do?ruta=2026/03/27/pdf/2026_2193.pdf&tipo=rutaDocm
  //HTML: https://docm.jccm.es/docm/verArchivoHtml.do?ruta=2026/03/27/html/2026_2193.html&tipo=rutaDocm --> MAL: se puede formar a partir de lo que tenemos?
  //PDF: https://docm.jccm.es/docm/descargarArchivo.do?ruta=2026/03/27/pdf/2026_2193.pdf&tipo=rutaDocm  --> MAL: se puede formar a partir de lo que tenemos?
 // { nombre: "DOCM", tipo: "html_directo", url: "https://docm.jccm.es/docm/cambiarBoletin.do?fecha={YYYYMMDD}", ambito: "Castilla-La Mancha" },   
  
  //HTML: https://bocyl.jcyl.es/html/2026/03/27/html/BOCYL-D-27032026-60-4.do   --> MAL: SUSTITUIR pdf POR html
  //PDF: https://bocyl.jcyl.es/boletines/2026/03/27/pdf/BOCYL-D-27032026-60-4.pdf --> OK
 // { nombre: "BOCYL", tipo: "html_directo", url: "https://bocyl.jcyl.es/boletin.do?fechaBoletin={DD/MM/YYYY}#I.B._AUTORIDADES_Y_PERSONAL", ambito: "Castilla y León" },
  
  // BOIB (Baleares): Extraemos el enlace del día de hoy desde su RSS y le añadimos la sección
  { nombre: "BOIB", tipo: "html_directo", url: "https://www.caib.es/eboibfront/indexrss.do?lang=es", ambito: "Islas Baleares", boibRssToHtml: true },

  //HTML: https://miprincipado.asturias.es/bopa/disposiciones?p_p_id=pa_sede_bopa_web_portlet_SedeBopaDispositionWeb&p_p_lifecycle=0&_pa_sede_bopa_web_portlet_SedeBopaDispositionWeb_mvcRenderCommandName=%2Fdisposition%2Fdetail&p_r_p_dispositionText=2026-02233&p_r_p_dispositionReference=2026-02233&p_r_p_dispositionDate=27%2F03%2F2026   --> MAL: SE PUEDE FORMAR A PARTIR DEL CODIGO
  //PDF: https://miprincipado.asturias.es/bopa/2026/03/27/2026-02233.pdf --> OK
 // { nombre: "BOPA", tipo: "html_directo", url: "https://sede.asturias.es/ultimos-boletines?p_r_p_summaryLastBopa=true", ambito: "Asturias" },
  
  //HTML: https://bon.navarra.es/es/anuncio/-/texto/2026/62/39   --> OK
  //PDF: https://bon.navarra.es/es/anuncio/-/texto/2026/62/39 --> MAL: NO HAY PDF, PONER LO MISMO QUE EN HTML
 // { nombre: "BON", tipo: "html_directo", url: "https://bon.navarra.es/es/ultimo", ambito: "Navarra" },

  // 🛑 BOLETINES EN "CUARENTENA" (Requieren Scraping de 2 Fases, RSS privados o bypass avanzado)
  // { nombre: "BOC_CANTABRIA", tipo: "html_directo", url: "https://boc.cantabria.es/boces/boletines.do", ambito: "Cantabria" }
  // { nombre: "BOCCE", tipo: "html_directo", url: "https://www.ceuta.es/ceuta/bocce", ambito: "Ceuta" },
  // { nombre: "BOME", tipo: "html_directo", url: "https://bomemelilla.es/", ambito: "Melilla" },
  // { nombre: "BOR", tipo: "html_directo", url: "https://web.larioja.org/bor-portada", ambito: "La Rioja" },
  // { nombre: "DOGC", tipo: "html_directo", url: "https://dogc.gencat.cat/es/inici/resultats/index.html?orderBy=3&page=1&typeSearch=1&advanced=true&current=true&title=true&numResultsByPage=50&publicationDateInitial={DD/MM/YYYY}&thematicDescriptor=D4090&thematicDescriptor=DE1738", ambito: "Cataluña" }
];

module.exports = {
  FUENTES_BOLETINES
};
