const { Client } = require('pg');
const nodemailer = require('nodemailer');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    try {
        const { username, email } = JSON.parse(event.body);
        if (!username || !email) return { statusCode: 400, body: JSON.stringify({ error: 'Faltan datos' }) };

        const codigo = Math.floor(100000 + Math.random() * 900000).toString();

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
        // Opcional: Puedes usar tokenDecodificado.username en lugar del username del body para mayor seguridad
        // --------------------------------------------------

        await client.connect();

        // CORRECCIÓN: Actualizar por username
        await client.query('UPDATE usuarios_sistema SET codigo_verificacion_email = $1 WHERE username = $2', [codigo, username]);
        await client.end();

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });

        await transporter.sendMail({
            from: `"Vigilex ERP" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: 'Código de Vinculación - Vigilex',
            html: `<h3>Tu código de verificación es: <span style="color:#1565c0; font-size:24px; letter-spacing:2px;">${codigo}</span></h3><p>Ingrésalo en la plataforma para vincular tu correo.</p>`
        });

        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Error al enviar correo' }) };
    }
};