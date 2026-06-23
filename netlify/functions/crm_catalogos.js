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

        // ACCIÓN: OBTENER TODOS LOS CATÁLOGOS (Materias y Vías)
        if (body.accion === 'obtener') {
            const resMaterias = await client.query(`SELECT nombre_materia, id_materia FROM catalogo_materias ORDER BY nombre_materia ASC`);
            const resVias = await client.query(`SELECT nombre_via, nombre_materia, id_via FROM catalogo_vias ORDER BY nombre_via ASC`);

            await client.end();
            return {
                statusCode: 200,
                body: JSON.stringify({
                    success: true,
                    materias_personalizadas: resMaterias.rows,
                    vias_personalizadas: resVias.rows
                })
            };
        }

        // ACCIÓN: AGREGAR MATERIA
        else if (body.accion === 'agregar_materia') {
            await client.query(`INSERT INTO catalogo_materias (nombre_materia, creado_por) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [body.nombre_materia, body.username]);
            await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // ACCIÓN: ELIMINAR MATERIA
        else if (body.accion === 'eliminar_materia') {
            await client.query(`DELETE FROM catalogo_materias WHERE id_materia = $1`, [body.id_materia]);
            // Opcional: Podrías borrar las vías asociadas, pero por ahora lo dejamos así para no ser destructivos
            await client.query(`DELETE FROM catalogo_vias WHERE nombre_materia = (SELECT nombre_materia FROM catalogo_materias WHERE id_materia = $1)`, [body.id_materia]);
            await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // ACCIÓN: AGREGAR VÍA
        else if (body.accion === 'agregar_via') {
            await client.query(`INSERT INTO catalogo_vias (nombre_materia, nombre_via, creado_por) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [body.nombre_materia, body.nombre_via, body.username]);
            await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // ACCIÓN: ELIMINAR VÍA
        else if (body.accion === 'eliminar_via') {
            await client.query(`DELETE FROM catalogo_vias WHERE id_via = $1`, [body.id_via]);
            await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        await client.end();
        return { statusCode: 400, body: JSON.stringify({ error: 'Acción de catálogo no válida' }) };
    } catch (error) {
        if (client) { try { await client.end(); } catch (e) { } }
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};