const { Client } = require('pg');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    try {
        const { id_notificacion, username } = JSON.parse(event.body);

        // Si es una alerta dinámica (empieza con 'dinamica_'), no hacemos nada en la BD, 
        // ya que desaparecen solas cuando el usuario completa la tarea.
        if (id_notificacion && id_notificacion.toString().startsWith('dinamica_')) {
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

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

        await client.query(`UPDATE notificaciones SET leida = TRUE WHERE id_notificacion = $1 AND username_destino = $2`, [id_notificacion, username]);

        await client.end();
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Fallo al actualizar.' }) };
    }
};