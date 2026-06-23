const { schedule } = require('@netlify/functions');
const { Client } = require('pg');
const nodemailer = require('nodemailer');

// 0 15 * * * = Todos los días a las 14:00 UTC (8:00 AM Centro de México)
exports.handler = schedule('0 14 * * *', async (event) => {
    const client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });

    try {
        await client.connect();

        // 1. Extraemos las tareas que vencen en los próximos 2 días (Hoy, Mañana o Pasado Mañana)
        const tareasRes = await client.query(`
            SELECT t.descripcion, t.fecha_vencimiento,
                   e.numero_expediente, 
                   COALESCE(e.id_firma, u.id_firma) as id_firma,
                   COALESCE(u.nombre_real, t.asignado_a) as responsable
            FROM tareas_expediente t
            LEFT JOIN usuarios_sistema u ON t.asignado_a = u.username
            LEFT JOIN expedientes e ON t.id_expediente = e.id_expediente
            WHERE t.fecha_vencimiento::date IN (CURRENT_DATE, CURRENT_DATE + INTERVAL '1 day', CURRENT_DATE + INTERVAL '2 days')
            AND t.estado NOT IN ('realizada', 'en_revision')
            ORDER BY t.fecha_vencimiento ASC
        `);

        if (tareasRes.rows.length === 0) {
            await client.end();
            return { statusCode: 200, body: 'Sin plazos críticos en todo el sistema.' };
        }

        // Agrupamos las tareas por Despacho (id_firma)
        const tareasPorFirma = {};
        tareasRes.rows.forEach(t => {
            if (!t.id_firma) return;
            if (!tareasPorFirma[t.id_firma]) tareasPorFirma[t.id_firma] = [];
            tareasPorFirma[t.id_firma].push(t);
        });

        // 2. Extraemos a todos los usuarios válidos
        const usersRes = await client.query(`SELECT id_firma, username, email, nombre_real FROM usuarios_sistema WHERE email IS NOT NULL AND email != ''`);

        // 3. Configuración de Brevo
        const transporter = nodemailer.createTransport({
            host: 'smtp-relay.brevo.com',
            port: 587,
            secure: false,
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });
        const sender = process.env.EMAIL_SENDER || process.env.EMAIL_USER;

        // 4. Enviamos 1 correo por usuario con TODAS las tareas de su Firma
        for (const u of usersRes.rows) {
            const tareasDespacho = tareasPorFirma[u.id_firma];

            // Si su firma no tiene tareas urgentes, lo saltamos
            if (!tareasDespacho || tareasDespacho.length === 0) continue;

            let listaHtml = '';
            let nivelAlertaMail = '#fbc02d'; // Amarillo por defecto (48h)
            let tituloMail = '⚠️ EN 48 HORAS - Alertas del Despacho';
            let prioridadMaxima = 2; // 0 = Hoy, 1 = Mañana, 2 = En 2 días

            // Pre-cálculo para definir el color general del correo (basado en la tarea más urgente)
            const hoyExacto = new Date().toISOString().split('T')[0];
            const mananaExacto = new Date(Date.now() + 86400000).toISOString().split('T')[0];

            tareasDespacho.forEach(t => {
                const fechaStr = new Date(t.fecha_vencimiento).toISOString().split('T')[0];
                if (fechaStr === hoyExacto) prioridadMaxima = 0;
                else if (fechaStr === mananaExacto && prioridadMaxima > 1) prioridadMaxima = 1;
            });

            if (prioridadMaxima === 0) {
                nivelAlertaMail = '#c62828'; // Rojo
                tituloMail = '🚨 VENCE HOY - Alertas Críticas del Despacho';
            } else if (prioridadMaxima === 1) {
                nivelAlertaMail = '#f57c00'; // Naranja
                tituloMail = '⚠️ VENCE MAÑANA - Alertas del Despacho';
            }

            // Construimos la lista de tareas HTML
            tareasDespacho.forEach(t => {
                const fechaStr = new Date(t.fecha_vencimiento).toISOString().split('T')[0];

                let colorBadge = '#fbc02d'; // Amarillo (48h)
                let txtBadge = 'VENCE EN 2 DÍAS';

                if (fechaStr === hoyExacto) {
                    colorBadge = '#c62828'; // Rojo
                    txtBadge = 'VENCE HOY';
                } else if (fechaStr === mananaExacto) {
                    colorBadge = '#f57c00'; // Naranja
                    txtBadge = 'VENCE MAÑANA';
                }

                const conceptoLimpio = t.descripcion.replace('PLAZO:', '').trim();

                listaHtml += `
                <div style="background-color: #fffaf9; border: 1px solid #feeaea; border-radius: 6px; border-left: 4px solid ${colorBadge}; text-align: left; margin-bottom: 15px;">
                    <div style="padding: 15px;">
                        <span style="background-color: ${colorBadge}; color: ${colorBadge === '#fbc02d' ? '#333' : 'white'}; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; letter-spacing: 1px; display: inline-block; margin-bottom: 10px;">${txtBadge}</span>
                        <p style="margin: 0 0 5px 0; font-size: 14px; color: #444444;"><b>Responsable:</b> ${t.responsable}</p>
                        <p style="margin: 0 0 5px 0; font-size: 14px; color: #444444;"><b>Expediente:</b> ${t.numero_expediente || 'S/N'}</p>
                        <p style="margin: 0; font-size: 14px; color: #444444;"><b>Tarea / Plazo:</b> ${conceptoLimpio}</p>
                    </div>
                </div>`;
            });

            const htmlCorreo = `
            <!DOCTYPE html>
            <html>
            <head><meta charset="utf-8"></head>
            <body style="background-color: #f4f6f8; margin: 0; padding: 40px 20px; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">
                <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.08); border-top: 6px solid ${nivelAlertaMail};">
                    <tr>
                        <td style="padding: 40px 30px; text-align: center;">
                            <img src="https://www.vigilex.mx/logo-vigilex.png" alt="VIGILEX" style="max-width: 220px; height: auto; object-fit: contain; display: block; margin: 0 auto 25px auto;">
                            
                            <h2 style="margin: 0 0 10px 0; color: ${nivelAlertaMail}; font-family: 'Georgia', serif; font-size: 22px; text-transform: uppercase; letter-spacing: 1px;">🚨 AGENDA JURISDICCIONAL</h2>
                            
                            <p style="color: #555555; font-size: 15px; line-height: 1.6; text-align: left; margin-bottom: 25px;">Estimado/a Lic. <b>${u.nombre_real || u.username}</b>,<br><br>A continuación se enlistan los términos, plazos y diligencias críticas correspondientes a todo su Despacho que vencen en las próximas 48 horas. Se requiere coordinación inmediata para evitar preclusiones:</p>
                            
                            ${listaHtml}
                            
                            <div style="margin-top: 40px;">
                                <a href="https://www.vigilex.mx/calendario.html?tipo=institucional" style="display: inline-block; background-color: ${nivelAlertaMail}; color: ${prioridadMaxima === 2 ? '#333' : '#ffffff'}; text-decoration: none; padding: 14px 35px; border-radius: 4px; font-weight: bold; font-size: 14px; letter-spacing: 1px; text-transform: uppercase;">Abrir Calendario Institucional</a>
                            </div>
                        </td>
                    </tr>
                    <tr>
                        <td style="background-color: #f9f9f9; padding: 20px; text-align: center; border-top: 1px solid #eeeeee;">
                            <p style="margin: 0; color: #999999; font-size: 11px;">Notificación Prioritaria del Sistema Central de VIGILEX. No responder a este correo.</p>
                        </td>
                    </tr>
                </table>
            </body>
            </html>
            `;

            await transporter.sendMail({
                from: `"VIGILEX Tribunal" <${sender}>`,
                to: u.email,
                subject: tituloMail,
                html: htmlCorreo
            });
        }

        await client.end();
        return { statusCode: 200, body: 'Alertas de plazos a 3 Tiempos enviadas correctamente.' };
    } catch (error) {
        if (client) await client.end();
        console.error("Error Alertas Plazos:", error);
        return { statusCode: 500, body: 'Error en servidor.' };
    }
});