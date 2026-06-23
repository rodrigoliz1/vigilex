const { Client } = require('pg');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    const client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });

    try {
        const { username, newPass } = JSON.parse(event.body);

        // --- BARRERA JWT ---
        const authHeader = event.headers?.authorization || event.headers?.Authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) return { statusCode: 401, body: JSON.stringify({ error: 'Token no proporcionado.' }) };

        try { jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); }
        catch (err) { return { statusCode: 401, body: JSON.stringify({ error: 'Token inválido o expirado.' }) }; }

        await client.connect();

        // 1. Obtener email y nombre real antes de cambiar (para saber a quién notificar)
        const userRes = await client.query('SELECT email, nombre_real FROM usuarios_sistema WHERE username = $1', [username]);
        if (userRes.rows.length === 0) {
            await client.end();
            return { statusCode: 404, body: JSON.stringify({ error: 'Usuario no encontrado.' }) };
        }

        const user = userRes.rows[0];

        // 2. Encriptar nueva contraseña
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPass, salt);

        // 3. Actualizar la contraseña en DB (y apagar cualquier bandera de cambio obligatorio)
        await client.query('UPDATE usuarios_sistema SET password_hash = $1, requiere_cambio_pass = false WHERE username = $2', [hashedPassword, username]);
        await client.end();

        // 4. ENVIAR CORREO PREMIUM DE CONFIRMACIÓN CON BREVO
        if (user.email) {
            const transporter = nodemailer.createTransport({
                host: 'smtp-relay.brevo.com', port: 587, secure: false,
                auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
            });
            const sender = process.env.EMAIL_SENDER || process.env.EMAIL_USER;

            // Obtenemos la fecha exacta en hora de México
            const fechaMexico = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City', dateStyle: 'long', timeStyle: 'short' });

            const htmlEmail = `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
                <div style="background-color: #0a2540; padding: 30px; text-align: center; border-bottom: 4px solid #2e7d32;">
                    <img src="https://www.vigilex.mx/logo-vigilex.png" alt="VIGILEX" style="width: 160px;">
                </div>
                <div style="padding: 40px; background-color: #ffffff;">
                    <h2 style="color: #0a2540; margin-top: 0; text-align: center;">Cambio de Contraseña Exitoso</h2>
                    <p style="font-size: 16px; line-height: 1.6; text-align: center;">
                        Hola <strong>${user.nombre_real || username}</strong>,
                    </p>
                    <p style="font-size: 16px; line-height: 1.6; text-align: center;">
                        Te confirmamos que la contraseña de tu cuenta institucional en <strong>VIGILEX</strong> ha sido actualizada correctamente.
                    </p>

                    <div style="background-color: #e8f5e9; border-left: 5px solid #2e7d32; padding: 20px; margin: 30px 0; text-align: center; border-radius: 8px;">
                        <p style="margin: 0 0 5px 0; font-size: 12px; color: #2e7d32; text-transform: uppercase; font-weight: bold;">FECHA DEL CAMBIO</p>
                        <p style="margin: 0; font-size: 18px; font-weight: bold; color: #0a2540;">${fechaMexico}</p>
                    </div>

                    <p style="font-size: 13px; color: #c62828; text-align: center; border-top: 1px solid #eee; padding-top: 20px; font-style: italic;">
                        <strong>Aviso de Seguridad:</strong> Si tú no realizaste este cambio, por favor contacta a soporte técnico inmediatamente, ya que tu cuenta podría estar comprometida.
                    </p>
                </div>
                <div style="background-color: #f8f9fa; padding: 20px; text-align: center; border-top: 1px solid #eee;">
                    <p style="margin: 0; font-size: 12px; color: #999;">VIGILEX | Departamento de Ciberseguridad<br>Este es un correo automático, por favor no respondas.</p>
                </div>
            </div>`;

            await transporter.sendMail({
                from: `"VIGILEX Seguridad" <${sender}>`,
                to: user.email,
                subject: '✅ Confirmación de Cambio de Contraseña - VIGILEX',
                html: htmlEmail
            });
        }

        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error) {
        if (client) await client.end();
        console.error("Error cambiando pass:", error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Error interno del servidor.' }) };
    }
};