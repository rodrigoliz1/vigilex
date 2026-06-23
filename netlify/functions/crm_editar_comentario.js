const { Client } = require('pg');
const jwt = require('jsonwebtoken');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    // --- BARRERA DE SEGURIDAD JWT ---
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return { statusCode: 401, body: JSON.stringify({ error: 'Acceso denegado.' }) };
    try { jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); } catch (err) { return { statusCode: 401, body: JSON.stringify({ error: 'Token inválido.' }) }; }

    try {
        const { username, id_seguimiento, comentario } = JSON.parse(event.body);
        if (!id_seguimiento || !comentario) return { statusCode: 400, body: JSON.stringify({ error: 'Faltan datos' }) };

        const client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });
        await client.connect();

        // CORRECCIÓN: Tabla seguimiento_expedientes (con 'S')
        const query = `
            UPDATE seguimiento_expedientes s
            SET comentario = $1
            FROM expedientes e
            JOIN usuarios_sistema u ON e.id_firma = u.id_firma
            WHERE s.id_expediente = e.id_expediente 
              AND s.id_seguimiento = $2 
              AND u.username = $3
        `;

        await client.query(query, [comentario, id_seguimiento, username]);
        await client.end();

        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error) {
        console.error("Error al editar comentario:", error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Error del servidor' }) };
    }
};