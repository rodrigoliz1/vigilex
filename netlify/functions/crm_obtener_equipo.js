const { Client } = require('pg');

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
        // Opcional: Puedes usar tokenDecodificado.username en lugar del username del body para mayor seguridad
        // --------------------------------------------------

        await client.connect();

        // Extrae a todos los usuarios que compartan el mismo id_firma que el usuario que lo solicita
        const query = `
            SELECT u.username, u.rol_equipo 
            FROM usuarios_sistema u
            WHERE u.id_firma = (SELECT id_firma FROM usuarios_sistema WHERE username = $1 LIMIT 1)
            ORDER BY u.rol_equipo DESC, u.username ASC
        `;
        const res = await client.query(query, [username]);
        await client.end();

        return { statusCode: 200, body: JSON.stringify({ success: true, equipo: res.rows }) };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Error al obtener equipo del despacho.' }) };
    }
};