const { Client } = require('pg');
const jwt = require('jsonwebtoken');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    // --- BARRERA DE SEGURIDAD JWT ---
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return { statusCode: 401, body: JSON.stringify({ error: 'Acceso denegado.' }) };
    try { jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); } catch (err) { return { statusCode: 401, body: JSON.stringify({ error: 'Token inválido.' }) }; }

    try {
        const { username, id_expediente } = JSON.parse(event.body);
        const client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });
        await client.connect();

        const checkResult = await client.query(`
            SELECT e.id_expediente 
            FROM expedientes e
            JOIN usuarios_sistema u ON e.id_firma = u.id_firma
            WHERE e.id_expediente = $1 AND u.username = $2
        `, [id_expediente, username]);

        if (checkResult.rows.length === 0) { await client.end(); return { statusCode: 403, body: JSON.stringify({ error: 'Denegado' }) }; }

        // PURGA AUTOMÁTICA
        await client.query(`
            DELETE FROM bitacora_calculos 
            WHERE id_expediente = $1 
              AND agotado = TRUE 
              AND fecha_fin < CURRENT_DATE
        `, [id_expediente]);

        // EXTRACCIÓN DE PLAZOS ACTIVOS (Corrección SQL)
        const terminosQuery = `
            SELECT id_calculo, materia as concepto, fecha_inicio, fecha_fin as vencimiento, detalle, fecha_registro, username as computado_por, agotado
            FROM bitacora_calculos 
            WHERE id_expediente = $1 
            ORDER BY agotado ASC, fecha_fin DESC;
        `;
        const terminosResult = await client.query(terminosQuery, [id_expediente]);

        await client.end();
        return { statusCode: 200, body: JSON.stringify({ success: true, terminos_activos: terminosResult.rows }) };
    } catch (error) {
        console.error(error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Error del servidor al cargar detalles.' }) };
    }
};