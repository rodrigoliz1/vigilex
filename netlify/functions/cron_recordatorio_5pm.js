const { schedule } = require('@netlify/functions');
const { Client } = require('pg');
const nodemailer = require('nodemailer');

// 0 23 * * 1-5 = Lunes a Viernes a las 23:00 UTC (5:00 PM Centro de México)
exports.handler = schedule('0 23 * * 1-5', async (event) => {
    const client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });

    try {
        await client.connect();

        // CORREGIDO: email en lugar de correo_electronico
        const res = await client.query(`
            SELECT u.email, u.nombre_real, u.username, COUNT(t.id_tarea) as tareas_pendientes
            FROM usuarios_sistema u
            JOIN tareas_expediente t ON u.username = t.asignado_a
            WHERE t.fecha_vencimiento::date = CURRENT_DATE 
            AND t.estado NOT IN ('realizada', 'en_revision')
            GROUP BY u.email, u.nombre_real, u.username
        `);

        if (res.rows.length === 0) {
            await client.end();
            return { statusCode: 200, body: 'Todo el equipo ha cerrado sus tareas de hoy.' };
        }

        const transporter = nodemailer.createTransport({
            host: 'smtp-relay.brevo.com',
            port: 587,
            secure: false,
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });
        const sender = process.env.EMAIL_SENDER || process.env.EMAIL_USER;

        for (const u of res.rows) {
            const htmlCorreo = `
            <!DOCTYPE html>
            <html>
            <head><meta charset="utf-8"></head>
            <body style="background-color: #f4f6f8; margin: 0; padding: 40px 20px; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">
                <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.08); border-top: 6px solid #0a2540;">
                    <tr>
                        <td style="padding: 40px 30px; text-align: center;">
                            <img src="https://www.vigilex.mx/logo-vigilex.png" alt="VIGILEX" style="max-width: 220px; height: auto; object-fit: contain; display: block; margin: 0 auto 25px auto;">
                            
                            <h2 style="margin: 0 0 10px 0; color: #0a2540; font-family: 'Georgia', serif; font-size: 22px; text-transform: uppercase; letter-spacing: 1px;">⚡ CORTE DE CAJA: 5:00 PM</h2>
                            
                            <p style="color: #555555; font-size: 15px; line-height: 1.6; text-align: left; margin-top: 25px;">Estimado/a Lic. <b>${u.nombre_real || u.username}</b>,<br><br>Le recordamos que la jornada laboral está por concluir y el sistema detecta que aún cuenta con <b>${u.tareas_pendientes} tarea(s) pendiente(s)</b> programadas para el día de hoy.</p>
                            
                            <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #fffde7; border: 1px solid #ffeeba; border-radius: 6px; border-left: 4px solid #c62828; text-align: left; margin: 25px 0;">
                                <tr>
                                    <td style="padding: 20px;">
                                        <p style="margin: 0 0 10px 0; font-size: 14px; color: #c62828; font-weight: bold; text-transform: uppercase;">🚨 ADVERTENCIA DE DESEMPEÑO</p>
                                        <p style="margin: 0; font-size: 13px; color: #555555; line-height: 1.5;">De no completar estas gestiones o enviarlas a Mesa de Revisión antes de la medianoche, su <b>VigiScore</b> sufrirá una penalización automática por incumplimiento.</p>
                                    </td>
                                </tr>
                            </table>
                            
                            <div style="margin-top: 35px;">
                                <a href="https://www.vigilex.mx/expedientes.html" style="display: inline-block; background-color: #0a2540; color: #ffffff; text-decoration: none; padding: 14px 35px; border-radius: 4px; font-weight: bold; font-size: 14px; letter-spacing: 1px; text-transform: uppercase;">Cerrar Pendientes Ahora</a>
                            </div>
                        </td>
                    </tr>
                    <tr>
                        <td style="background-color: #f9f9f9; padding: 20px; text-align: center; border-top: 1px solid #eeeeee;">
                            <p style="margin: 0; color: #999999; font-size: 11px;">Notificación Preventiva del Sistema Central de VIGILEX. No responder a este correo.</p>
                        </td>
                    </tr>
                </table>
            </body>
            </html>
            `;

            // CORREGIDO
            await transporter.sendMail({
                from: `"VIGILEX Control Operativo" <${sender}>`,
                to: u.email,
                subject: `⚡ Recordatorio de Cierre: ${u.tareas_pendientes} Tareas Pendientes Hoy`,
                html: htmlCorreo
            });
        }

        await client.end();
        return { statusCode: 200, body: 'Recordatorios de 5PM enviados correctamente.' };
    } catch (error) {
        if (client) await client.end();
        console.error("Error en cron 5PM:", error);
        return { statusCode: 500, body: 'Error en servidor.' };
    }
});