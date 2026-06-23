const { Client } = require('pg');
const jwt = require('jsonwebtoken');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    // --- BARRERA DE SEGURIDAD ---
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader) return { statusCode: 401, body: JSON.stringify({ error: 'No token' }) };
    try {
        jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    } catch (e) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid token' }) };
    }

    let client;
    try {
        const body = JSON.parse(event.body);
        const { username, accion, id_tarea, enlace, comentario } = body;

        console.log(`[AUDITORIA] Peticion: ${accion} | Tarea ID: ${id_tarea} | Usuario: ${username}`);

        if (!id_tarea) {
            throw new Error("El sistema no recibió el ID de la tarea.");
        }

        client = new Client({
            connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED,
            ssl: { rejectUnauthorized: false }
        });
        await client.connect();

        // 1. OBTENER TODOS LOS DETALLES
        if (accion === 'obtener') {
            console.log(`[AUDITORIA] Extrayendo tarea ${id_tarea}...`);
            const tRes = await client.query(`SELECT * FROM tareas_expediente WHERE id_tarea = $1`, [id_tarea]);

            console.log(`[AUDITORIA] Extrayendo historial...`);
            const hRes = await client.query(`SELECT username, accion, fecha_registro FROM historial_tareas WHERE id_tarea = $1 ORDER BY fecha_registro DESC`, [id_tarea]);

            console.log(`[AUDITORIA] Extrayendo comentarios...`);
            const cRes = await client.query(`SELECT username, comentario, es_revision, fecha_registro FROM comentarios_tarea WHERE id_tarea = $1 ORDER BY fecha_registro ASC`, [id_tarea]);

            await client.end();

            // Retornamos arrays u objetos vacíos en lugar de 'undefined' si algo no existe
            return {
                statusCode: 200,
                body: JSON.stringify({
                    success: true,
                    tarea: tRes.rows.length > 0 ? tRes.rows[0] : {},
                    historial: hRes.rows || [],
                    comentarios: cRes.rows || []
                })
            };
        }
        // 2. GUARDAR EL ENLACE AL DOCUMENTO Y REGISTRAR EN EL HISTORIAL
        else if (accion === 'guardar_enlace') {
            await client.query(`UPDATE tareas_expediente SET enlace_documento = $1 WHERE id_tarea = $2`, [enlace, id_tarea]);
            await client.query(`INSERT INTO historial_tareas (id_tarea, username, accion) VALUES ($1, $2, '📎 Actualizó el enlace del documento')`, [id_tarea, username]);
            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }
        // 3. AGREGAR UN COMENTARIO REGULAR A LA TAREA
        else if (accion === 'agregar_comentario') {
            await client.query(`INSERT INTO comentarios_tarea (id_tarea, username, comentario, es_revision) VALUES ($1, $2, $3, false)`, [id_tarea, username, comentario]);
            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        await client.end();
        return { statusCode: 400, body: JSON.stringify({ error: 'Acción no válida' }) };

    } catch (error) {
        console.error("[AUDITORIA ERROR FATAL]:", error.message);
        if (client) {
            try { await client.end(); } catch (e) { }
        }
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};