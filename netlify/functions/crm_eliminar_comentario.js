const { Client } = require('pg');
const jwt = require('jsonwebtoken');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    // --- BARRERA DE SEGURIDAD JWT ---
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return { statusCode: 401, body: JSON.stringify({ error: 'Acceso denegado.' }) };
    try { jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); } catch (err) { return { statusCode: 401, body: JSON.stringify({ error: 'Token inválido.' }) }; }

    try {
        const { username, id_seguimiento } = JSON.parse(event.body);
        if (!id_seguimiento) return { statusCode: 400, body: JSON.stringify({ error: 'ID requerido' }) };

        const client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });
        await client.connect();

        // CORRECCIÓN: Tabla seguimiento_expedientes (con 'S')
        const checkQuery = `
            SELECT s.id_seguimiento FROM seguimiento_expedientes s
            JOIN expedientes e ON s.id_expediente = e.id_expediente
            JOIN usuarios_sistema u ON e.id_firma = u.id_firma
            WHERE s.id_seguimiento = $1 AND u.username = $2
        `;
        const checkRes = await client.query(checkQuery, [id_seguimiento, username]);

        if (checkRes.rows.length === 0) {
            await client.end();
            return { statusCode: 403, body: JSON.stringify({ error: 'Acceso denegado o registro inexistente.' }) };
        }

        // CORRECCIÓN: Tabla seguimiento_expedientes (con 'S')
        await client.query('DELETE FROM seguimiento_expedientes WHERE id_seguimiento = $1', [id_seguimiento]);

        await client.end();
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error) {
        console.error("Error al eliminar comentario:", error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Error en el servidor' }) };
    }
};