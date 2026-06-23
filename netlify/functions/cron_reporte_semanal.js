const { schedule } = require('@netlify/functions');
const { Client } = require('pg');
const nodemailer = require('nodemailer');

// 0 0 * * 6 = Sábado a las 00:00 UTC (Viernes a las 6:00 PM Centro de México)
exports.handler = schedule('0 0 * * 6', async (event) => {
    const client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });

    try {
        await client.connect();

        // 1. Extraer a todo el equipo (CORREGIDO: Quitamos estado_cuenta y solo pedimos que tengan correo)
        const users = await client.query(`SELECT username, email, nombre_real FROM usuarios_sistema WHERE email IS NOT NULL AND email != ''`);

        if (users.rows.length === 0) {
            await client.end();
            return { statusCode: 200, body: 'No hay usuarios con correo para enviar reportes.' };
        }

        // --- CONEXIÓN A BREVO ---
        const transporter = nodemailer.createTransport({
            host: 'smtp-relay.brevo.com',
            port: 587,
            secure: false,
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });
        const sender = process.env.EMAIL_SENDER || process.env.EMAIL_USER;

        // 2. Calcular el VigiScore y enviar
        for (const u of users.rows) {
            // Evaluamos la tabla blindada de auditoría de los últimos 7 días
            const stats = await client.query(`
                SELECT 
                    COUNT(*) FILTER (WHERE accion IN ('Completada', 'A Presentar')) as exitos,
                    COUNT(*) FILTER (WHERE accion = 'A Corregir') as errores,
                    COUNT(*) FILTER (WHERE accion = 'PRORROGA') as prorrogas
                FROM auditoria_tareas 
                WHERE abogado = $1 AND fecha_accion >= CURRENT_DATE - INTERVAL '7 days'
            `, [u.username]);

            const s = stats.rows[0];
            const exitos = parseInt(s.exitos) || 0;
            const errores = parseInt(s.errores) || 0;
            const prorrogas = parseInt(s.prorrogas) || 0;

            let score = 100 - (errores * 10) - (prorrogas * 5);
            if (score < 0) score = 0;

            if (exitos === 0 && errores === 0 && prorrogas === 0) {
                score = 0;
            }

            let colorScore = score >= 90 ? '#2e7d32' : (score >= 75 ? '#ad974f' : '#c62828');
            let txtNivel = score >= 90 ? 'ÉLITE' : (score >= 75 ? 'CONFIABLE' : 'ALTO RIESGO');
            if (exitos === 0 && errores === 0 && prorrogas === 0) {
                colorScore = '#888888';
                txtNivel = 'SIN ACTIVIDAD';
            }

            const htmlCorreo = `
            <!DOCTYPE html>
            <html>
            <head><meta charset="utf-8"></head>
            <body style="background-color: #f4f6f8; margin: 0; padding: 40px 20px; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">
                <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.08); border-top: 6px solid ${colorScore};">
                    <tr>
                        <td style="padding: 40px 30px; text-align: center;">
                            <img src="https://www.vigilex.mx/logo-vigilex.png" alt="VIGILEX" style="max-width: 220px; height: auto; object-fit: contain; display: block; margin: 0 auto 25px auto;">
                            
                            <h2 style="margin: 0 0 10px 0; color: #0a2540; font-family: 'Georgia', serif; font-size: 22px; text-transform: uppercase; letter-spacing: 1px;">MÉTRICA DE RENDIMIENTO</h2>
                            <p style="color: #777777; font-size: 12px; margin-top: 0; letter-spacing: 2px; text-transform: uppercase;">Boletín Semanal</p>
                            
                            <p style="color: #555555; font-size: 15px; line-height: 1.6; text-align: left; margin-top: 25px;">Lic. <b>${u.nombre_real || u.username}</b>,<br><br>Ha concluido una semana operativa más. Los Algoritmos de VIGILEX Analytics han procesado su rendimiento en base a la calidad y puntualidad de sus entregas.</p>
                            
                            <div style="background-color: #fcfcfc; border: 1px solid #eeeeee; border-radius: 50%; width: 200px; height: 200px; margin: 35px auto; display: table;">
                                <div style="display: table-cell; vertical-align: middle;">
                                    <span style="font-size: 65px; font-weight: 900; color: ${colorScore}; font-family: 'Georgia', serif; line-height: 1; display: block;">${score}</span>
                                    <span style="font-size: 11px; color: #888888; font-weight: bold; letter-spacing: 1px; display: block; margin-top: 5px;">VIGISCORE</span>
                                </div>
                            </div>

                            <h3 style="color: ${colorScore}; margin: 0 0 30px 0; font-size: 18px; letter-spacing: 1px;">NIVEL: ${txtNivel}</h3>
                            
                            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 30px; border-top: 1px solid #eeeeee; padding-top: 25px;">
                                <tr>
                                    <td style="text-align: center; width: 33%;">
                                        <span style="font-size: 22px; font-weight: bold; color: #2e7d32; display: block;">${exitos}</span>
                                        <span style="font-size: 10px; color: #888888; text-transform: uppercase; font-weight: bold;">Logros Aprobados</span>
                                    </td>
                                    <td style="text-align: center; width: 33%; border-left: 1px solid #eeeeee; border-right: 1px solid #eeeeee;">
                                        <span style="font-size: 22px; font-weight: bold; color: #c62828; display: block;">${errores}</span>
                                        <span style="font-size: 10px; color: #888888; text-transform: uppercase; font-weight: bold;">Correcciones</span>
                                    </td>
                                    <td style="text-align: center; width: 33%;">
                                        <span style="font-size: 22px; font-weight: bold; color: #f57c00; display: block;">${prorrogas}</span>
                                        <span style="font-size: 10px; color: #888888; text-transform: uppercase; font-weight: bold;">Prórrogas / Ajustes</span>
                                    </td>
                                </tr>
                            </table>
                            
                            <div style="margin-top: 35px;">
                                <a href="https://www.vigilex.mx/desempeno.html?abogado=${u.username}" style="display: inline-block; background-color: #ad974f; color: #ffffff; text-decoration: none; padding: 14px 35px; border-radius: 4px; font-weight: bold; font-size: 14px; letter-spacing: 1px; text-transform: uppercase;">Descargar Reporte PDF Detallado</a>
                            </div>
                        </td>
                    </tr>
                    <tr>
                        <td style="background-color: #f9f9f9; padding: 20px; text-align: center; border-top: 1px solid #eeeeee;">
                            <p style="margin: 0; color: #999999; font-size: 11px;">Evaluación automatizada por la Inteligencia Operativa de VIGILEX.</p>
                        </td>
                    </tr>
                </table>
            </body>
            </html>
            `;

            await transporter.sendMail({
                from: `"VIGILEX Analytics" <${sender}>`,
                to: u.email,
                subject: `📊 Su Reporte Semanal VigiScore: ${score}/100`,
                html: htmlCorreo
            });
        }

        await client.end();
        return { statusCode: 200, body: 'Reportes enviados correctamente.' };
    } catch (error) {
        if (client) await client.end();
        console.error("Error Reporte Semanal:", error);
        return { statusCode: 500, body: 'Error en servidor.' };
    }
});