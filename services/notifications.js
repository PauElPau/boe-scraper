const { Resend } = require('resend');
const { supabase } = require('./db');
const { esperar } = require('../utils/helpers');

// --- 7. SISTEMAS DE ALERTAS ---

// HELPER INTERNO: Para los colores de las etiquetas en el email (Igual que en Frontend)
function getEmailTypeData(tipo) {
  if (!tipo) return { bg: '#f3f4f6', color: '#4b5563', icon: '📄', label: 'Proceso' };
  const map = {
    'Plazas de Nuevo Ingreso': { bg: '#dcfce7', color: '#166534', border: '#bbf7d0', icon: '🟢', label: 'Nuevo Ingreso' },
    'Procesos de Estabilización': { bg: '#dbeafe', color: '#1e40af', border: '#bfdbfe', icon: '🔵', label: 'Estabilización' },
    'Bolsas de Empleo Temporal': { bg: '#ffedd5', color: '#b45309', border: '#fed7aa', icon: '🟠', label: 'Bolsa de Empleo' },
    'Provisión de Puestos y Movilidad': { bg: '#e9d5ff', color: '#6b21a8', border: '#d8b4fe', icon: '🟣', label: 'Movilidad/Traslado' },
    'Ofertas de Empleo Público (OEP)': { bg: '#cffafe', color: '#0e7490', border: '#a5f3fc', icon: '🌐', label: 'Oferta (OEP)' }
  };
  return map[tipo] || { bg: '#f3f4f6', color: '#4b5563', border: '#e5e7eb', icon: '📄', label: tipo };
}

function getEmailFaseData(fase) {
  if (!fase) return { texto: 'Convocatoria', icono: '📢', bg: '#fffbeb', color: '#b45309', border: '#fde68a' };
  const map = {
    'Apertura de Plazos / Convocatoria': { texto: 'Plazo Abierto', icono: '🟢', bg: '#ecfdf5', color: '#059669', border: '#a7f3d0' },
    'Listas de Admitidos y Excluidos': { texto: 'Listados', icono: '📝', bg: '#fffbeb', color: '#b45309', border: '#fde68a' },
    'Tribunales y Fechas de Examen': { texto: 'Exámenes', icono: '✍️', bg: '#f0fdf4', color: '#166534', border: '#bbf7d0' },
    'Calificaciones y Resultados': { texto: 'Notas', icono: '📊', bg: '#fffbeb', color: '#b45309', border: '#fde68a' },
    'Adjudicación y Nombramientos': { texto: 'Finalizado', icono: '🏁', bg: '#f3f4f6', color: '#374151', border: '#d1d5db' },
    'Correcciones y Modificaciones': { texto: 'Corrección', icono: '⚙️', bg: '#fffbeb', color: '#b45309', border: '#fde68a' },
    'Otros Trámites': { texto: 'Trámite', icono: '📄', bg: '#fffbeb', color: '#b45309', border: '#fde68a' }
  };
  return map[fase] || { texto: fase, icono: '🔔', bg: '#fffbeb', color: '#b45309', border: '#fde68a' };
}


async function enviarAlertasPorEmail(nuevasConvocatorias) {
  let contadorEnviados = 0; 
  
  // 🚀 ACTUALIZADO: Filtro con los nombres de la Matriz 3D
  const convocatoriasReales = nuevasConvocatorias.filter(c => 
    c.type === 'Plazas de Nuevo Ingreso' || 
    c.type === 'Procesos de Estabilización' || 
    c.type === 'Bolsas de Empleo Temporal'
  );
  
  if (convocatoriasReales.length === 0 || !process.env.RESEND_API_KEY) return 0;

  const resend = new Resend(process.env.RESEND_API_KEY);
  const { data: radares } = await supabase.from('filtros_radar').select('*');
  if (!radares || radares.length === 0) return 0;

  const normalizarTexto = (texto) => {
    if (!texto) return "";
    return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  };

  for (const radar of radares) {
    if (!radar.filtro) continue;
    const terminoBusqueda = normalizarTexto(radar.filtro.trim());
    const provinciasSub = radar.provincias || []; 

    const coincidencias = convocatoriasReales.filter(conv => {
      const superCadena = normalizarTexto(`
        ${conv.title || ''} 
        ${conv.resumen || ''} 
        ${conv.department || ''} 
        ${conv.profesion || ''}
      `);
      const encajaInteres = superCadena.includes(terminoBusqueda);
      let encajaProvincia = true;
      if (provinciasSub.length > 0) {
          encajaProvincia = provinciasSub.includes(conv.provincia);
      }
      return encajaInteres && encajaProvincia;
    });

    if (coincidencias.length > 0) {
      const { data: userData } = await supabase.auth.admin.getUserById(radar.user_id);
      if (!userData || !userData.user || !userData.user.email) continue;
      const userEmail = userData.user.email;

      // 🎨 DISEÑO TIPO TARJETA FRONTEND PARA EL LISTADO
      const htmlLista = coincidencias.map(c => {
        const typeStyle = getEmailTypeData(c.type);
        const faseStyle = getEmailFaseData(c.fase);
        
        const badgePlazas = c.plazas ? `<span style="color: #059669; font-weight: 600; font-size: 13px; display: inline-block; margin-top: 8px;">🧑‍🤝‍🧑 ${c.plazas} ${c.plazas > 1 ? 'Plazas' : 'Plaza'}</span>` : '';
        const fechaCierreLimpia = c.fecha_cierre ? c.fecha_cierre.split('-').reverse().join('/') : null;
        const infoCierre = fechaCierreLimpia ? `<div style="background: #fef3c7; color: #b45309; padding: 6px 12px; border-radius: 50px; font-size: 12px; font-weight: 600; display: inline-block; margin-top: 8px; border: 1px solid #fde68a;">📅 Plazo aprox: ${fechaCierreLimpia}</div>` : '';

        return `
        <div style="background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin-bottom: 20px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
          
          <div style="margin-bottom: 12px;">
            <span style="background-color: ${faseStyle.bg}; color: ${faseStyle.color}; border: 1px solid ${faseStyle.border}; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; display: inline-block; margin-bottom: 8px;">
              ${faseStyle.icono} ${faseStyle.texto}
            </span><br>
            <span style="background-color: ${typeStyle.bg}; color: ${typeStyle.color}; border: 1px solid ${typeStyle.border}; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; display: inline-block;">
              ${typeStyle.icon} ${typeStyle.label}
            </span>
          </div>

          <h3 style="margin: 0 0 8px 0; color: #0f172a; font-size: 18px; font-weight: 700; line-height: 1.3;">
            <a href="https://topos.es/convocatorias/${c.slug}" style="color: #0f172a; text-decoration: none;">${c.profesion || c.title}</a>
          </h3>
          
          <p style="margin: 0 0 12px 0; color: #475569; font-size: 14px; line-height: 1.5;">${c.resumen || ''}</p>

          <div style="background: #f8fafc; padding: 12px; border-radius: 8px; font-size: 13px; color: #475569; margin-bottom: 16px;">
            <div style="margin-bottom: 4px;">🏛️ <strong>${c.department || 'Administración'}</strong></div>
            <div>📍 ${c.provincia || 'Estatal'}</div>
            ${badgePlazas}
          </div>
          
          ${infoCierre}
          
          <div style="margin-top: 16px; text-align: center;">
             <a href="https://topos.es/convocatorias/${c.slug}" style="display: inline-block; background-color: #d97706; color: #ffffff; text-decoration: none; padding: 10px 24px; border-radius: 8px; font-size: 14px; font-weight: 600;">Ver detalles de la plaza &rarr;</a>
          </div>
        </div>`
      }).join('');

      try {
        const emailHTML = `
        <div style="background-color: #f1f5f9; padding: 40px 10px; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
          <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #cbd5e1; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1);">
            
            <div style="background-color: #ffffff; padding: 25px 30px; text-align: center; border-bottom: 1px solid #e2e8f0;">
              <h1 style="color: #d97706; margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -0.5px;">TOPOS.es 🐾</h1>
              <p style="color: #64748b; font-size: 14px; margin: 5px 0 0 0;">Tu rastreador de empleo público</p>
            </div>
            
            <div style="padding: 35px 30px; background-color: #f8fafc;">
              <h2 style="margin-top: 0; margin-bottom: 15px; color: #0f172a; font-size: 22px; font-weight: 800;">¡El Topo ha encontrado algo!</h2>
              <p style="color: #475569; font-size: 15px; line-height: 1.6; margin-bottom: 30px; margin-top: 0;">
                Escarbando en los boletines de esta madrugada, hemos desenterrado nuevas plazas que coinciden con tu rastro de búsqueda: <strong style="color: #b45309; background: #fef3c7; padding: 4px 8px; border-radius: 6px; border: 1px solid #fde68a;">${radar.filtro}</strong>
              </p>
              
              ${htmlLista}
              
            </div>

            <div style="background-color: #ffffff; padding: 30px; text-align: center; border-top: 1px solid #e2e8f0;">
              <p style="color: #64748b; font-size: 13px; margin: 0 0 15px 0; line-height: 1.6;">
                Recibes este correo porque El Topo está vigilando este rastro para ti en nuestra base de datos.
              </p>
              <a href="https://topos.es/perfil" style="color: #d97706; font-size: 13px; font-weight: 600; text-decoration: underline; display: block; margin-bottom: 25px;">Gestionar mis alertas desde la Madriguera</a>
              
              <div style="padding-top: 20px; border-top: 1px dashed #cbd5e1;">
                <p style="color: #94a3b8; font-size: 12px; line-height: 1.5; margin: 0;">
                  🤖 Este es un mensaje automático, por favor no respondas a este correo.<br>
                  Si necesitas ayuda escríbenos a <a href="mailto:info@topos.es" style="color: #94a3b8; text-decoration: underline;">info@topos.es</a>.
                </p>
              </div>
            </div>

          </div>
        </div>
        `;

        await resend.emails.send({
          from: 'TOPOS.es <alertas@topos.es>', 
          to: userEmail,
          subject: `🐾 Nuevas plazas rastreadas: ${radar.filtro}`,
          html: emailHTML
        });
        contadorEnviados++;
        await esperar(1000); 
      } catch (err) { }
    }
  }
  return contadorEnviados;
}

async function enviarAlertasFavoritos(nuevasConvocatorias) {
  let contadorEnviados = 0; 
  const actualizaciones = nuevasConvocatorias.filter(c => c.parent_slug);
  if (actualizaciones.length === 0 || !process.env.RESEND_API_KEY) return 0;

  const resend = new Resend(process.env.RESEND_API_KEY);
  for (const update of actualizaciones) {
    const { data: seguidores } = await supabase.from('favoritos').select('user_id').eq('convocatoria_slug', update.parent_slug);
    if (!seguidores || seguidores.length === 0) continue;

    for (const seguidor of seguidores) {
      const { data: userData } = await supabase.auth.admin.getUserById(seguidor.user_id);
      if (userData && userData.user && userData.user.email) {
        
        const faseStyle = getEmailFaseData(update.fase);

        try {
          const emailHTML = `
          <div style="background-color: #f1f5f9; padding: 40px 10px; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
            <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #cbd5e1; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1);">
              
              <div style="background-color: #ffffff; padding: 25px 30px; text-align: center; border-bottom: 1px solid #e2e8f0;">
                <span style="font-size: 32px; display: block; margin-bottom: 10px;">🐾</span>
                <h1 style="color: #0f172a; margin: 0; font-size: 24px; font-weight: 800;">Novedades en tu plaza</h1>
              </div>

              <div style="padding: 35px 30px; background-color: #f8fafc;">
                <p style="color: #475569; font-size: 16px; line-height: 1.6; margin-top: 0; text-align: center;">El Topo ha detectado un <strong>nuevo trámite oficial</strong> publicado hoy para la plaza que vigilas.</p>
                
                <div style="background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin: 25px 0; box-shadow: 0 2px 4px rgba(0,0,0,0.02);">
                  <div style="margin-bottom: 15px; border-bottom: 1px solid #f1f5f9; padding-bottom: 15px;">
                     <span style="background-color: #fef3c7; color: #b45309; border: 1px solid #fde68a; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; display: inline-block; margin-bottom: 8px;">
                        ⚡ Actualización del proceso
                     </span>
                     <h3 style="margin: 0; color: #0f172a; font-size: 16px; line-height: 1.4;">${update.resumen || update.title}</h3>
                  </div>
                  
                  <div style="background-color: ${faseStyle.bg}; border-left: 4px solid ${faseStyle.color}; padding: 12px 16px; border-radius: 0 6px 6px 0;">
                    <span style="color: ${faseStyle.color}; font-size: 13px; text-transform: uppercase; font-weight: 700; letter-spacing: 0.5px; display: block; margin-bottom: 4px;">Fase Actual:</span>
                    <strong style="color: #0f172a; font-size: 15px;">${faseStyle.icono} ${faseStyle.texto}</strong>
                  </div>
                </div>

                <div style="text-align: center;">
                   <a href="https://topos.es/convocatorias/${update.slug}" style="display: inline-block; background-color: #d97706; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-size: 15px; font-weight: 600; box-shadow: 0 4px 6px -1px rgba(217, 119, 6, 0.2);">Ver documento en TOPOS.es &rarr;</a>
                </div>
              </div>

              <div style="background-color: #ffffff; padding: 30px; text-align: center; border-top: 1px solid #e2e8f0;">
                <a href="https://topos.es/perfil" style="color: #64748b; font-size: 13px; font-weight: 500; text-decoration: underline; display: block; margin-bottom: 20px;">Gestionar mis plazas vigiladas</a>

                <div style="padding-top: 20px; border-top: 1px dashed #cbd5e1;">
                  <p style="color: #94a3b8; font-size: 12px; line-height: 1.5; margin: 0;">
                    🤖 Este es un mensaje automático, por favor no respondas a este correo.<br>
                    Si necesitas ayuda escríbenos a <a href="mailto:info@topos.es" style="color: #94a3b8; text-decoration: underline;">info@topos.es</a>.
                  </p>
                </div>
              </div>

            </div>
          </div>
          `;

          await resend.emails.send({
            from: 'TOPOS.es <alertas@topos.es>', 
            to: userData.user.email,
            subject: `🐾 Hay novedades en la plaza que vigilas`,
            html: emailHTML
          });
          contadorEnviados++;
          await esperar(1000); 
        } catch (err) { }
      }
    }
  }
  return contadorEnviados;
}

async function enviarAlertaTelegram(nuevasConvocatorias) {
  // 🚀 ACTUALIZADO: Filtro con los nombres de la Matriz 3D
  const convocatoriasReales = nuevasConvocatorias.filter(c => 
    c.type === 'Plazas de Nuevo Ingreso' || 
    c.type === 'Procesos de Estabilización' || 
    c.type === 'Bolsas de Empleo Temporal'
  );
  if (convocatoriasReales.length === 0) return;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHANNEL_ID; 
  if (!token || !chatId) return;

  let texto = `🐾 *¡El Topo acaba de salir a la superficie!* 🐾\n\nHoy ha desenterrado *${convocatoriasReales.length}* nuevas plazas:\n\n`;
  
  convocatoriasReales.slice(0, 10).forEach(c => {
    const plazas = c.plazas ? `(*${c.plazas} ${c.plazas === 1 ? 'plaza' : 'plazas'}*) ` : '';
    // 🚀 AÑADIDA LA FASE AL TELEGRAM
    texto += `💼 *${c.profesion || 'Nueva Convocatoria'}* ${plazas}\n📌 ${c.fase || 'Novedad'}\n🏛️ ${c.department || 'Administración'} ${c.provincia && c.provincia !== 'Estatal' ? `(${c.provincia})` : ''}\n👉 [Inspeccionar túnel](https://topos.es/convocatorias/${c.slug})\n\n`;
  });
  
  if (convocatoriasReales.length > 10) {
    texto += `_Y ${convocatoriasReales.length - 10} convocatorias más en la web._\n\n`;
  }
  
  texto += `🕳️ *Crea tu propia Madriguera* para que el Topo te avise por email solo de lo que te interesa: [Entrar gratis](https://topos.es)`;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'Markdown', disable_web_page_preview: true })
    });
  } catch (err) { }
}

async function enviarReporteAdmin(reporteStats, alertasEmail, alertasFavs, erroresGlobales, minutos) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID; 
  if (!token || !adminChatId) return;

  let texto = `🐾 *Reporte del Topo Jefe* 🐾\n⏱️ *Tiempo de excavación:* ${minutos} min\n\n`;

  let totalGuardadas = 0;

  for (const [boletin, stats] of Object.entries(reporteStats)) {
    if (stats.encontradas === 0 && stats.errores === 0) continue;
    totalGuardadas += stats.guardadas;

    texto += `📰 *${boletin}* (Encontradas: ${stats.encontradas})\n`;
    texto += `  ✅ Guardadas: ${stats.guardadas}\n`;
    if (stats.enlazadas > 0) texto += `  🔗 (De las cuales ${stats.enlazadas} vinculadas a un padre)\n`;
    if (stats.duplicados > 0) texto += `  🔄 Duplicados evitados: ${stats.duplicados}\n`;
    if (stats.descartadas_ia > 0) texto += `  🗑️ Descartadas (Basura/Genérico): ${stats.descartadas_ia}\n`;
    if (stats.descartadas_404 > 0) texto += `  ⚠️ Enlaces rotos (404): ${stats.descartadas_404}\n`;
    if (stats.errores > 0) texto += `  ❌ Errores: ${stats.errores}\n`;
    texto += `\n`;
  }

  texto += `📊 *RESUMEN GLOBAL*\n`;
  texto += `⛏️ Total nuevas guardadas: ${totalGuardadas}\n`;
  texto += `📨 Avisos de rastros (Email): ${alertasEmail}\n`;
  texto += `🔔 Alertas de vigiladas (Email): ${alertasFavs}\n`;
  texto += `💥 Errores web globales: ${erroresGlobales}\n`;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: adminChatId, text: texto, parse_mode: 'Markdown' })
    });
  } catch (err) { console.error("Error enviando Telegram Admin", err); }
}

module.exports = {
  enviarAlertasPorEmail,
  enviarAlertasFavoritos,
  enviarAlertaTelegram,
  enviarReporteAdmin
};