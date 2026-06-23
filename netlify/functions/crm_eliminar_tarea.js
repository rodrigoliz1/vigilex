const { Client } = require('pg');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    try {
        const { username, id_tarea } = JSON.parse(event.body);
        if (!id_tarea) return { statusCode: 400, body: JSON.stringify({ error: 'Faltan datos' }) };

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

        // Barrera de Seguridad: Validamos que el usuario pertenezca a la firma dueña de la tarea
        const checkQuery = `
            SELECT t.id_tarea FROM tareas_expediente t
            JOIN expedientes e ON t.id_expediente = e.id_expediente
            JOIN usuarios_sistema u ON e.id_firma = u.id_firma
            WHERE t.id_tarea = $1 AND u.username = $2
        `;
        const checkRes = await client.query(checkQuery, [id_tarea, username]);

        if (checkRes.rows.length === 0) {
            await client.end();
            return { statusCode: 403, body: JSON.stringify({ error: 'Acceso denegado o tarea inexistente.' }) };
        }

        // Eliminación de la tarea
        await client.query('DELETE FROM tareas_expediente WHERE id_tarea = $1', [id_tarea]);

        await client.end();
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error) {
        console.error("Error al eliminar tarea:", error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Error en el servidor al intentar eliminar la tarea.' }) };
    }
};