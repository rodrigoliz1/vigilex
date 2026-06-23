const { Client } = require('pg');
const jwt = require('jsonwebtoken');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader) return { statusCode: 401, body: JSON.stringify({ error: 'No token' }) };
    try { jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); } catch (e) { return { statusCode: 401, body: JSON.stringify({ error: 'Invalid' }) }; }

    let client;
    try {
        const { username, id_expediente, descripcion, fecha_vencimiento, categoria, asignado_a } = JSON.parse(event.body);
        client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });
        await client.connect();

        await client.query('BEGIN');
        const resInsert = await client.query(`
            INSERT INTO tareas_expediente (id_expediente, descripcion, fecha_vencimiento, categoria, creado_por, asignado_a) 
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING id_tarea
        `, [id_expediente, descripcion, fecha_vencimiento || null, categoria, username, asignado_a]);

        const idNuevaTarea = resInsert.rows[0].id_tarea;

        await client.query(`INSERT INTO historial_tareas (id_tarea, username, accion) VALUES ($1, $2, '✨ Creó la tarea')`, [idNuevaTarea, username]);

        // NOTIFICACIÓN ADAPTADA AL LOBBY
        if (asignado_a && asignado_a !== username) {
            try {
                await client.query(`
                    INSERT INTO notificaciones (username_destino, titulo, mensaje, tipo) 
                    VALUES ($1, '📌 Nueva Tarea Asignada', $2, 'info')
                `, [asignado_a, `${username} te ha asignado: ${descripcion}`]);
            } catch (e) { console.error(e); }
        }

        await client.query('COMMIT');
        await client.end();
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error) {
        if (client) { try { await client.query('ROLLBACK'); await client.end(); } catch (e) { } }
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};