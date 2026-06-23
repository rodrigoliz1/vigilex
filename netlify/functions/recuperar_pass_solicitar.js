const { Client } = require('pg');
const nodemailer = require('nodemailer');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    try {
        const { email } = JSON.parse(event.body);
        if (!email) return { statusCode: 400, body: JSON.stringify({ error: 'Correo requerido.' }) };

        const client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });
        await client.connect();

        const userRes = await client.query('SELECT username FROM usuarios_sistema WHERE email = $1 LIMIT 1', [email]);
        if (userRes.rows.length === 0) {
            await client.end();
            return { statusCode: 404, body: JSON.stringify({ error: 'Este correo no está registrado en ninguna cuenta.' }) };
        }

        const username = userRes.rows[0].username;
        const codigo = Math.floor(100000 + Math.random() * 900000).toString();

        await client.query('UPDATE usuarios_sistema SET codigo_verificacion_pass = $1 WHERE email = $2', [codigo, email]);
        await client.end();

        // 4. Enviamos el Correo Premium CON BREVO
        const transporter = nodemailer.createTransport({
            host: 'smtp-relay.brevo.com', port: 587, secure: false,
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });
        const sender = process.env.EMAIL_SENDER || process.env.EMAIL_USER;

        const htmlEmail = `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
            <div style="background-color: #0a2540; padding: 30px; text-align: center; border-bottom: 4px solid #c62828;">
                <img src="https://www.vigilex.mx/logo-vigilex.png" alt="VIGILEX" style="width: 160px;">
            </div>
            <div style="padding: 40px; background-color: #ffffff;">
                <h2 style="color: #0a2540; margin-top: 0; text-align: center;">Recuperación de Acceso</h2>
                <p style="font-size: 16px; line-height: 1.6;">Hola <strong>${username}</strong>,</p>
                <p style="font-size: 16px; line-height: 1.6;">
                    Se ha solicitado un restablecimiento de contraseña para tu cuenta institucional en VIGILEX. Ingresa el siguiente código de seguridad para continuar con el proceso:
                </p>

                <div style="background-color: #ffebee; border: 1px dashed #c62828; padding: 20px; margin: 30px 0; text-align: center; border-radius: 8px;">
                    <p style="margin: 0 0 5px 0; font-size: 12px; color: #c62828; text-transform: uppercase; font-weight: bold;">TU CÓDIGO OTP</p>
                    <p style="margin: 0; font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #0a2540;">${codigo}</p>
                </div>

                <p style="font-size: 13px; color: #888; text-align: center; border-top: 1px solid #eee; padding-top: 20px;">
                    Si no solicitaste este cambio, alguien más podría estar intentando acceder a tu cuenta. Ignora este correo y tu contraseña actual seguirá siendo segura.
                </p>
            </div>
            <div style="background-color: #f8f9fa; padding: 20px; text-align: center; border-top: 1px solid #eee;">
                <p style="margin: 0; font-size: 12px; color: #999;">VIGILEX | Departamento de Ciberseguridad<br>Este es un correo automático, por favor no respondas.</p>
            </div>
        </div>`;

        await transporter.sendMail({
            from: `"VIGILEX Seguridad" <${sender}>`,
            to: email,
            subject: '🔒 Código OTP de Recuperación de Contraseña',
            html: htmlEmail
        });

        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error) {
        console.error("Error en solicitar recuperación:", error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Error interno del servidor al procesar la solicitud.' }) };
    }
};