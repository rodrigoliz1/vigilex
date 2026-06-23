const { Client } = require('pg');
const nodemailer = require('nodemailer');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    const { accion, username, otp, nueva_pass } = JSON.parse(event.body);
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

    try {
        if (accion === 'verificar_otp') {
            // Buscamos al usuario y su código temporal (podemos usar el que se generó al invitarlo o uno nuevo)
            // Para esta fase, validaremos contra un campo 'codigo_verificacion' que el titular le envió
            const res = await client.query('SELECT email, codigo_verificacion FROM usuarios_sistema WHERE username = $1', [username]);
            const user = res.rows[0];

            if (user && user.codigo_verificacion === otp) {
                await client.query('UPDATE usuarios_sistema SET correo_confirmado = TRUE WHERE username = $1', [username]);
                await client.end();
                return { statusCode: 200, body: JSON.stringify({ success: true }) };
            } else {
                await client.end();
                return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Código inválido' }) };
            }
        }

        if (accion === 'finalizar_onboarding') {
            // Actualizamos la contraseña y apagamos la bandera de cambio obligatorio
            await client.query(`
                UPDATE usuarios_sistema 
                SET password_hash = $1, requiere_cambio_pass = FALSE 
                WHERE username = $1_user
            `.replace('$1_user', `'${username}'`), [nueva_pass]);

            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

    } catch (error) {
        await client.end();
        return { statusCode: 500, body: JSON.stringify({ success: false, error: error.message }) };
    }
};