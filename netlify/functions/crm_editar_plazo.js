const { Client } = require('pg');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    try {
        const { username, id_calculo, nuevo_concepto, nueva_fecha } = JSON.parse(event.body);
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

        const checkQuery = `
            SELECT b.id_calculo FROM bitacora_calculos b
            JOIN expedientes e ON b.id_expediente = e.id_expediente
            JOIN usuarios_sistema u ON e.id_firma = u.id_firma
            WHERE b.id_calculo = $1 AND u.username = $2
        `;
        const checkRes = await client.query(checkQuery, [id_calculo, username]);

        if (checkRes.rows.length === 0) {
            await client.end();
            return { statusCode: 403, body: JSON.stringify({ error: 'Acceso denegado o plazo inexistente.' }) };
        }

        // CORRECCIÓN: Usamos 'materia' que es la columna real de tu base de datos
        const updateQuery = `UPDATE bitacora_calculos SET materia = $1, fecha_fin = $2 WHERE id_calculo = $3`;
        await client.query(updateQuery, [nuevo_concepto, nueva_fecha, id_calculo]);

        await client.end();
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Error al editar el plazo.' }) };
    }
};