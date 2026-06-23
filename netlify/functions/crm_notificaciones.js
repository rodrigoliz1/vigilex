const { Client } = require('pg');
const jwt = require('jsonwebtoken');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };
    try {
        const authHeader = event.headers.authorization || event.headers.Authorization;
        if (!authHeader) return { statusCode: 401, body: JSON.stringify({ error: 'No token' }) };
        jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    } catch (e) { return { statusCode: 401, body: JSON.stringify({ error: 'Token inválido' }) }; }

    let client;
    try {
        const body = JSON.parse(event.body);
        client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });
        await client.connect();

        if (body.accion === 'obtener') {
            const res = await client.query(`SELECT id_notificacion, titulo, mensaje, leida, fecha_creacion FROM notificaciones WHERE username_destino = $1 ORDER BY fecha_creacion DESC LIMIT 30`, [body.username]);
            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true, notificaciones: res.rows }) };
        }
        else if (body.accion === 'marcar_leida') {
            await client.query(`UPDATE notificaciones SET leida = TRUE WHERE id_notificacion = $1 AND username_destino = $2`, [body.id_notificacion, body.username]);
            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }
        else if (body.accion === 'eliminar') {
            await client.query(`DELETE FROM notificaciones WHERE id_notificacion = $1 AND username_destino = $2`, [body.id_notificacion, body.username]);
            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }
        // --- ACCIÓN PARA ENVIAR RESPUESTA ---
        else if (body.accion === 'enviar_respuesta') {
            await client.query(`
                INSERT INTO notificaciones (username_destino, titulo, mensaje, tipo) 
                VALUES ($1, $2, $3, 'info')
            `, [body.destino, body.titulo, body.mensaje]);
            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        await client.end();
        return { statusCode: 400, body: JSON.stringify({ error: 'Acción no válida' }) };
    } catch (error) {
        if (client) { try { await client.end(); } catch (e) { } }
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};