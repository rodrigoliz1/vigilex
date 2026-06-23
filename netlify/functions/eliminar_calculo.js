const { Client } = require('pg');
exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };
    try {
        const { username, id_calculo, eliminar_calendario, concepto } = JSON.parse(event.body);
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

        await client.query(`DELETE FROM bitacora_calculos WHERE id_calculo = $1 AND username = $2`, [id_calculo, username]);

        // Si el usuario autorizó eliminar del calendario, buscamos por coincidencia de texto
        if (eliminar_calendario && concepto) {
            await client.query(`DELETE FROM eventos_calendario WHERE username = $1 AND titulo_evento ILIKE $2`, [username, `%${concepto}%`]);
        }

        await client.end();
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error) { return { statusCode: 500, body: JSON.stringify({ error: 'Fallo al eliminar cálculo' }) }; }
};