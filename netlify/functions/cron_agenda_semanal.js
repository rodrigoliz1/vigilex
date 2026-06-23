const { schedule } = require('@netlify/functions');
const { Client } = require('pg');
const nodemailer = require('nodemailer');

// 0 14 * * 1 = Lunes a las 14:00 UTC (8:00 AM Centro de México)
exports.handler = schedule('0 14 * * 1', async (event) => {
    const client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });

    try {
        await client.connect();

        // 1. Extraemos TODAS las tareas de los próximos 7 días, cruzadas con su Firma (id_firma)
        const tareasRes = await client.query(`
            SELECT t.descripcion, t.fecha_vencimiento,
                   e.numero_expediente, 
                   COALESCE(e.id_firma, u.id_firma) as id_firma,
                   COALESCE(u.nombre_real, t.asignado_a) as responsable
            FROM tareas_expediente t
            LEFT JOIN usuarios_sistema u ON t.asignado_a = u.username
            LEFT JOIN expedientes e ON t.id_expediente = e.id_expediente
            WHERE t.fecha_vencimiento::date BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '7 days')
            AND t.estado NOT IN ('realizada', 'en_revision')
            ORDER BY t.fecha_vencimiento ASC
        `);

        if (tareasRes.rows.length === 0) {
            await client.end();
            return { statusCode: 200, body: 'Sin agenda esta semana en el sistema.' };
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

            // Si su firma no tiene agenda próxima, lo saltamos
            if (!tareasDespacho || tareasDespacho.length === 0) continue;

            const filasTabla = tareasDespacho.map((t, index) => {
                const fondoFila = index % 2 === 0 ? '#ffffff' : '#f9fbfd';
                const fechaFormat = new Date(t.fecha_vencimiento).toLocaleDateString('es-MX', { weekday: 'short', day: '2-digit', month: 'short' }).toUpperCase();

                return `
                <tr style="background-color: ${fondoFila};">
                    <td style="padding: 12px 15px; border-bottom: 1px solid #eeeeee; color: #0a2540; font-weight: bold; font-size: 12px;">${t.responsable}</td>
                    <td style="padding: 12px 15px; border-bottom: 1px solid #eeeeee; color: #444444; font-size: 13px;">${t.descripcion} <br><span style="font-size:10px; color:#888;">Exp: ${t.numero_expediente || 'S/N'}</span></td>
                    <td style="padding: 12px 15px; border-bottom: 1px solid #eeeeee; color: #c62828; font-weight: bold; font-size: 12px; text-align: right;">${fechaFormat}</td>
                </tr>`;
            }).join('');

            const htmlCorreo = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
            </head>
            <body style="background-color: #f4f6f8; margin: 0; padding: 40px 20px; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">
                <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 650px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
                    <tr>
                        <td style="background-color: #0a2540; text-align: center; padding: 30px 20px; border-bottom: 4px solid #ad974f;">
                            <img src="https://www.vigilex.mx/logo-vigilex.png" alt="VIGILEX" style="max-width: 220px; height: auto; object-fit: contain; display: block; margin: 0 auto;">
                        </td>
                    </tr>
                    
                    <tr>
                        <td style="padding: 40px 30px;">
                            <h1 style="margin: 0 0 20px 0; color: #0a2540; font-family: 'Georgia', serif; font-size: 24px; font-weight: normal;">Proyección Operativa Semanal</h1>
                            <p style="color: #555555; font-size: 15px; line-height: 1.6; margin: 0 0 25px 0;">Estimado/a <b>Lic. ${u.nombre_real || u.username}</b>,<br><br>A continuación, le presentamos el resumen global de los términos y tareas programadas para toda su Firma durante los próximos 7 días:</p>
                            
                            <table width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid #dddddd; border-radius: 6px; overflow: hidden;">
                                <thead>
                                    <tr style="background-color: #f0f4f8;">
                                        <th style="padding: 15px; text-align: left; color: #0a2540; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; border-bottom: 2px solid #dddddd;">Responsable</th>
                                        <th style="padding: 15px; text-align: left; color: #0a2540; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; border-bottom: 2px solid #dddddd;">Tarea / Exp</th>
                                        <th style="padding: 15px; text-align: right; color: #0a2540; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; border-bottom: 2px solid #dddddd;">Límite</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${filasTabla}
                                </tbody>
                            </table>
                            
                            <p style="color: #777777; font-size: 13px; line-height: 1.5; margin: 30px 0 0 0; text-align: center;">
                                Mantener visibilidad sobre la agenda de toda la Firma garantiza el éxito y la coordinación del equipo.
                            </p>
                            
                            <div style="text-align: center; margin-top: 35px;">
                                <a href="https://www.vigilex.mx/expedientes.html" style="display: inline-block; background-color: #ad974f; color: #ffffff; text-decoration: none; padding: 14px 30px; border-radius: 4px; font-weight: bold; font-size: 14px; letter-spacing: 1px; text-transform: uppercase;">Acceder a VIGILEX</a>
                            </div>
                        </td>
                    </tr>
                    
                    <tr>
                        <td style="background-color: #f9f9f9; padding: 20px; text-align: center; border-top: 1px solid #eeeeee;">
                            <p style="margin: 0; color: #999999; font-size: 11px;">Este es un mensaje automatizado generado por la Inteligencia Operativa de VIGILEX. Por favor, no responda a este correo.</p>
                        </td>
                    </tr>
                </table>
            </body>
            </html>
            `;

            await transporter.sendMail({
                from: `"VIGILEX Agenda" <${sender}>`,
                to: u.email,
                subject: `📅 Agenda Semanal de la Firma: Próximos Términos`,
                html: htmlCorreo
            });
        }

        await client.end();
        return { statusCode: 200, body: 'Agendas globales enviadas correctamente.' };
    } catch (error) {
        if (client) await client.end();
        console.error("Error en cron Agenda:", error);
        return { statusCode: 500, body: 'Error en servidor.' };
    }
});