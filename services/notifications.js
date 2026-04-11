const { Resend } = require('resend');
const { supabase } = require('./db');
const { esperar } = require('../utils/helpers');

// --- 7. SISTEMAS DE ALERTAS ---
async function enviarAlertasPorEmail(nuevasConvocatorias) {
  let contadorEnviados = 0; 
  const convocatoriasReales = nuevasConvocatorias.filter(c => c.type === 'Oposiciones (Turno Libre)' || c.type === 'Estabilización y Promoción' || c.type === 'Bolsas de Empleo Temporal');
  if (convocatoriasReales.length === 0 || !process.env.RESEND_API_KEY) return 0;

  const resend = new Resend(process.env.RESEND_API_KEY);
  
  const { data: radares } = await supabase.from('filtros_radar').select('*');
  if (!radares || radares.length === 0) return 0;

  for (const radar of radares) {
    if (!radar.filtro) continue;
    const interesStr = radar.filtro.toLowerCase().trim();
    const provinciasSub = radar.provincias || []; 

    const coincidencias = convocatoriasReales.filter(conv => {
      const enTitulo = conv.title && conv.title.toLowerCase().includes(interesStr);
      const enProfesion = conv.profesion && conv.profesion.toLowerCase().includes(interesStr);
      const encajaInteres = enTitulo || enProfesion;
      let encajaProvincia = true;
      if (provinciasSub.length > 0) encajaProvincia = provinciasSub.includes(conv.provincia);
      return encajaInteres && encajaProvincia;
    });

    if (coincidencias.length > 0) {
      const { data: userData } = await supabase.auth.admin.getUserById(radar.user_id);
      if (!userData || !userData.user || !userData.user.email) continue;
      const userEmail = userData.user.email;

      const htmlLista = coincidencias.map(c => {
        const badgePlazas = c.plazas ? `<span style="background-color: #fff7ed; color: #c2410c; padding: 3px 8px; border-radius: 12px; font-size: 12px; font-weight: bold; margin-left: 8px; vertical-align: middle; border: 1px solid #ffedd5;">${c.plazas} plaza${c.plazas > 1 ? 's' : ''}</span>` : '';
        const fechaCierreLimpia = c.fecha_cierre ? c.fecha_cierre.split('-').reverse().join('/') : null;
        const infoCierre = fechaCierreLimpia ? `<div style="color: #dc2626; font-size: 13px; font-weight: 600; margin-top: 6px;">⏳ Fin de plazo aprox: ${fechaCierreLimpia}</div>` : '';

        return `
        <div style="background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 18px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
          <h3 style="margin: 0 0 10px 0; color: #0f172a; font-size: 16px; font-weight: 700; line-height: 1.4;">
            ${c.profesion || c.title} ${badgePlazas}
          </h3>
          <div style="color: #475569; font-size: 14px; line-height: 1.5; margin-bottom: 16px;">
            <span style="display: block; margin-bottom: 4px;">🏛️ <strong>${c.department || 'Administración'}</strong></span>
            <span style="display: block;">📍 ${c.provincia || 'Estatal'}</span>
            ${infoCierre}
          </div>
          <a href="https://topos.es/convocatorias/${c.slug}" style="display: block; text-align: center; background-color: #ea580c; color: #ffffff; text-decoration: none; padding: 10px 16px; border-radius: 6px; font-size: 14px; font-weight: 600;">Inspeccionar túnel &rarr;</a>
        </div>`
      }).join('');

      try {
        const emailHTML = `
        <div style="background-color: #f8fafc; padding: 30px 10px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
          <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e2e8f0;">
            <div style="background-color: #ea580c; padding: 25px; text-align: center;">
              <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">TOPOS.es 🐾</h1>
            </div>
            <div style="padding: 30px 25px; background-color: #f8fafc;">
              <h2 style="margin-top: 0; margin-bottom: 15px; color: #1e293b; font-size: 20px;">¡El Topo ha encontrado algo!</h2>
              <p style="color: #475569; font-size: 15px; line-height: 1.6; margin-bottom: 25px; margin-top: 0;">
                Escarbando en los boletines de hoy, hemos desenterrado nuevas plazas que coinciden con tu rastro: <strong style="color: #ea580c; background: #ffedd5; padding: 2px 6px; border-radius: 4px;">${radar.filtro}</strong>
              </p>
              ${htmlLista}
            </div>
            <div style="background-color: #ffffff; padding: 25px; text-align: center; border-top: 1px solid #e2e8f0;">
              <p style="color: #64748b; font-size: 13px; margin: 0 0 10px 0; line-height: 1.5;">
                Recibes este correo porque El Topo está vigilando este rastro para ti. Puedes gestionar tus alertas o decirle que deje de buscar desde tu Madriguera.
              </p>
              <a href="https://topos.es/perfil" style="color: #94a3b8; font-size: 12px; text-decoration: underline; display: block; margin-bottom: 20px;">Ir a mi Madriguera</a>
              
              <div style="padding-top: 15px; border-top: 1px dashed #e2e8f0;">
                <p style="color: #94a3b8; font-size: 11px; line-height: 1.5; margin: 0;">
                  🤖 Este es un mensaje automático, por favor no respondas a este correo.<br>
                  Si necesitas ayuda o quieres ponerte en contacto con nosotros, escríbenos a <a href="mailto:info@topos.es" style="color: #94a3b8; text-decoration: underline;">info@topos.es</a>.
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
        try {
          const emailHTML = `
          <div style="background-color: #f8fafc; padding: 30px 10px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
            <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e2e8f0;">
              <div style="background-color: #10b981; padding: 25px; text-align: center;">
                <span style="font-size: 32px; display: block; margin-bottom: 10px;">🐾</span>
                <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: 800;">Novedades en tu plaza vigilada</h1>
              </div>
              <div style="padding: 30px 25px;">
                <p style="color: #475569; font-size: 16px; line-height: 1.6; margin-top: 0;">El Topo ha detectado un <strong>nuevo trámite oficial</strong> publicado hoy en los boletines para la plaza que tienes guardada en tu Madriguera.</p>
                <div style="background-color: #ecfdf5; border-left: 4px solid #10b981; border-radius: 0 8px 8px 0; padding: 16px; margin: 25px 0;">
                  <strong style="color: #065f46; display: block; margin-bottom: 6px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">Actualización detectada:</strong>
                  <span style="color: #047857; font-size: 15px; line-height: 1.5;">${update.resumen || update.title}</span>
                </div>
                <a href="https://topos.es/convocatorias/${update.slug}" style="display: block; text-align: center; background-color: #10b981; color: #ffffff; text-decoration: none; padding: 12px 20px; border-radius: 6px; font-size: 15px; font-weight: 600;">Ver documento oficial &rarr;</a>
              </div>
              <div style="background-color: #ffffff; padding: 25px; text-align: center; border-top: 1px solid #e2e8f0;">
                <a href="https://topos.es/perfil" style="color: #94a3b8; font-size: 12px; text-decoration: underline; display: block; margin-bottom: 20px;">Gestionar mis plazas desde la Madriguera</a>

                <div style="padding-top: 15px; border-top: 1px dashed #e2e8f0;">
                  <p style="color: #94a3b8; font-size: 11px; line-height: 1.5; margin: 0;">
                    🤖 Este es un mensaje automático, por favor no respondas a este correo.<br>
                    Si necesitas ayuda o quieres contactarnos, escríbenos a <a href="mailto:info@topos.es" style="color: #94a3b8; text-decoration: underline;">info@topos.es</a>.
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
  const convocatoriasReales = nuevasConvocatorias.filter(c => c.type === 'Oposiciones (Turno Libre)' || c.type === 'Estabilización y Promoción' || c.type === 'Bolsas de Empleo Temporal');
  if (convocatoriasReales.length === 0) return;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHANNEL_ID; 
  if (!token || !chatId) return;

  let texto = `🐾 *¡El Topo acaba de salir a la superficie!* 🐾\n\nHoy ha desenterrado *${convocatoriasReales.length}* nuevas plazas:\n\n`;
  
  convocatoriasReales.slice(0, 10).forEach(c => {
    const plazas = c.plazas ? `(*${c.plazas} ${c.plazas === 1 ? 'plaza' : 'plazas'}*) ` : '';
    texto += `💼 *${c.profesion || 'Nueva Convocatoria'}* ${plazas}\n🏛️ ${c.department || 'Administración'} ${c.provincia && c.provincia !== 'Estatal' ? `(${c.provincia})` : ''}\n👉 [Inspeccionar túnel](https://topos.es/convocatorias/${c.slug})\n\n`;
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
    // Si no encontró nada y no hubo errores, no lo ponemos para no ensuciar el mensaje
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
