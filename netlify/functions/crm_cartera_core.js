const { Client } = require('pg');
const jwt = require('jsonwebtoken');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };
    try {
        const authHeader = event.headers.authorization || event.headers.Authorization;
        jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    } catch (e) { return { statusCode: 401, body: JSON.stringify({ error: 'Token inválido' }) }; }

    let client;
    try {
        const { accion, propietario, invitado, rol_cartera, id_acceso } = JSON.parse(event.body);
        client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });
        await client.connect();

        if (accion === 'obtener_accesos') {
            const res = await client.query('SELECT * FROM accesos_cartera WHERE propietario_cartera = $1 ORDER BY id_acceso ASC', [propietario]);
            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true, accesos: res.rows }) };
        }

        if (accion === 'otorgar_acceso') {
            // Evitar duplicados
            const check = await client.query('SELECT id_acceso FROM accesos_cartera WHERE propietario_cartera = $1 AND usuario_invitado = $2', [propietario, invitado]);
            if (check.rows.length === 0) {
                await client.query('INSERT INTO accesos_cartera (propietario_cartera, usuario_invitado, rol_en_cartera) VALUES ($1, $2, $3)', [propietario, invitado, rol_cartera]);
            }
            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        if (accion === 'revocar_acceso') {
            await client.query('DELETE FROM accesos_cartera WHERE id_acceso = $1', [id_acceso]);
            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        await client.end();
        return { statusCode: 400, body: JSON.stringify({ error: 'Acción inválida' }) };
    } catch (error) {
        if (client) await client.end();
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};