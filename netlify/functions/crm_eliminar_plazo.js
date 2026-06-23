const { Client } = require('pg');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    try {
        const { id_calculo } = JSON.parse(event.body);
        if (!id_calculo) return { statusCode: 400, body: JSON.stringify({ error: 'ID de cálculo requerido' }) };

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

        // Eliminamos el plazo de la bitácora
        await client.query('DELETE FROM bitacora_calculos WHERE id_calculo = $1', [id_calculo]);

        await client.end();
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error) {
        console.error("Error al eliminar plazo:", error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Error en el servidor' }) };
    }
};