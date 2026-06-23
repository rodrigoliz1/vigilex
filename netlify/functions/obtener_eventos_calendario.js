const { Client } = require('pg');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    try {
        const { username, tipo } = JSON.parse(event.body);
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

        let query = "";
        let params = [];

        // ALIAS EN SQL: Traducimos "id_evento" a "id", "titulo_evento" a "title", etc., para que FullCalendar los lea.
        if (tipo === 'institucional') {
            query = `
                SELECT 
                    e.id_evento AS id, 
                    e.titulo_evento AS title, 
                    e.fecha_vencimiento AS start, 
                    e.fecha_termino AS end, 
                    e.todo_el_dia AS "allDay",
                    e.creado_por,
                    '#ad974f' AS color 
                FROM eventos_calendario e
                JOIN usuarios_sistema u ON e.creado_por = u.username
                WHERE u.id_firma = (SELECT id_firma FROM usuarios_sistema WHERE username = $1 LIMIT 1)
                AND e.tipo_calendario = 'institucional'
            `;
            params = [username];
        } else {
            query = `
                SELECT 
                    id_evento AS id, 
                    titulo_evento AS title, 
                    fecha_vencimiento AS start, 
                    fecha_termino AS end, 
                    todo_el_dia AS "allDay",
                    creado_por,
                    '#0a2540' AS color
                FROM eventos_calendario 
                WHERE username = $1 AND tipo_calendario = 'personal'
            `;
            params = [username];
        }

        const res = await client.query(query, params);
        await client.end();

        return { statusCode: 200, body: JSON.stringify({ success: true, eventos: res.rows }) };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};