const { Client } = require('pg');
const nodemailer = require('nodemailer');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    try {
        const { username } = JSON.parse(event.body);
        const client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });

        // --- 1. BARRERA DE SEGURIDAD JWT (EL CADENERO) ---
        const jwt = require('jsonwebtoken');
        const authHeader = event.headers.authorization || event.headers.Authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return { statusCode: 401, body: JSON.stringify({ error: 'Acceso denegado. Token no proporcionado.' }) };
        }

        const token = authHeader.split(' ')[1];
        let tokenDecodificado;

        try {
            tokenDecodificado = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            return { statusCode: 401, body: JSON.stringify({ error: 'Acceso denegado. Token inválido o expirado.' }) };
        }
        // --------------------------------------------------

        await client.connect();

        const res = await client.query('SELECT email FROM usuarios_sistema WHERE username = $1', [username]);
        if (res.rows.length === 0 || !res.rows[0].email) {
            await client.end();
            return { statusCode: 400, body: JSON.stringify({ error: 'No tienes un correo vinculado para recuperar contraseña.' }) };
        }

        const email = res.rows[0].email;
        const codigo = Math.floor(100000 + Math.random() * 900000).toString();

        await client.query('UPDATE usuarios_sistema SET codigo_verificacion_pass = $1 WHERE username = $2', [codigo, username]);
        await client.end();

        // Enviamos el Correo Premium CON BREVO
        const transporter = nodemailer.createTransport({
            host: 'smtp-relay.brevo.com', port: 587, secure: false,
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });
        const sender = process.env.EMAIL_SENDER || process.env.EMAIL_USER;

        const htmlEmail = `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
            <div style="background-color: #0a2540; padding: 30px; text-align: center; border-bottom: 4px solid #fbc02d;">
                <img src="https://www.vigilex.mx/logo-vigilex.png" alt="VIGILEX" style="width: 160px;">
            </div>
            <div style="padding: 40px; background-color: #ffffff;">
                <h2 style="color: #0a2540; margin-top: 0; text-align: center;">Autorización de Seguridad</h2>
                <p style="font-size: 16px; line-height: 1.6; text-align: center;">
                    Has solicitado cambiar la contraseña de tu cuenta <strong>${username}</strong> desde tu panel de configuración.
                </p>

                <div style="background-color: #fff9c4; border: 1px dashed #fbc02d; padding: 20px; margin: 30px 0; text-align: center; border-radius: 8px;">
                    <p style="margin: 0 0 5px 0; font-size: 12px; color: #856404; text-transform: uppercase; font-weight: bold;">CÓDIGO DE AUTORIZACIÓN (OTP)</p>
                    <p style="margin: 0; font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #0a2540;">${codigo}</p>
                </div>

                <p style="font-size: 13px; color: #888; text-align: center; border-top: 1px solid #eee; padding-top: 20px;">
                    Ingresa este código en la plataforma para habilitar el formulario de nueva contraseña. Si no fuiste tú quien solicitó este cambio, puedes ignorar este mensaje.
                </p>
            </div>
            <div style="background-color: #f8f9fa; padding: 20px; text-align: center; border-top: 1px solid #eee;">
                <p style="margin: 0; font-size: 12px; color: #999;">VIGILEX | Departamento de Ciberseguridad<br>Este es un correo automático, por favor no respondas.</p>
            </div>
        </div>`;

        await transporter.sendMail({
            from: `"VIGILEX Seguridad" <${sender}>`,
            to: email,
            subject: '🛡️ Autorización para Cambio de Contraseña',
            html: htmlEmail
        });

        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Error al enviar correo' }) };
    }
};