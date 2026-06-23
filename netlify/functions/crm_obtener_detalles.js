const { Client } = require('pg');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    try {
        const { username, id_expediente } = JSON.parse(event.body);
        if (!username || !id_expediente) return { statusCode: 400, body: JSON.stringify({ error: 'Parámetros incompletos.' }) };

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

        // NUEVA SEGURIDAD: Validar que el usuario pertenece a la misma FIRMA que el expediente
        const checkOwner = await client.query(`
            SELECT e.id_expediente 
            FROM expedientes e
            JOIN usuarios_sistema u ON e.id_firma = u.id_firma
            WHERE e.id_expediente = $1 AND u.username = $2
        `, [id_expediente, username]);

        if (checkOwner.rows.length === 0) {
            await client.end();
            return { statusCode: 403, body: JSON.stringify({ error: 'Acceso denegado al expediente.' }) };
        }

        await client.query(`DELETE FROM tareas_expediente WHERE id_expediente = $1 AND estado = 'realizada' AND fecha_completada < NOW() - INTERVAL '8 days'`, [id_expediente]);

        const resComentarios = await client.query('SELECT * FROM seguimiento_expedientes WHERE id_expediente = $1 ORDER BY fecha_registro DESC', [id_expediente]);
        const resTareas = await client.query(`SELECT * FROM tareas_expediente WHERE id_expediente = $1 ORDER BY CASE WHEN estado = 'pendiente' THEN 1 ELSE 2 END, fecha_vencimiento ASC NULLS LAST`, [id_expediente]);

        await client.end();
        return { statusCode: 200, body: JSON.stringify({ success: true, comentarios: resComentarios.rows, tareas: resTareas.rows }) };

    } catch (error) { return { statusCode: 500, body: JSON.stringify({ error: 'Error interno del servidor.' }) }; }
};