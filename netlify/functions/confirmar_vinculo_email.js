const { Client } = require('pg');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    try {
        const { username, email, code } = JSON.parse(event.body);
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

        // CORRECCIÓN: Buscar y actualizar por username
        const res = await client.query('SELECT codigo_verificacion_email FROM usuarios_sistema WHERE username = $1', [username]);

        if (res.rows.length > 0 && res.rows[0].codigo_verificacion_email === code) {
            await client.query('UPDATE usuarios_sistema SET email = $1, codigo_verificacion_email = NULL WHERE username = $2', [email, username]);
            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        } else {
            await client.end();
            return { statusCode: 400, body: JSON.stringify({ error: 'Código incorrecto' }) };
        }
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Error al validar' }) };
    }
};