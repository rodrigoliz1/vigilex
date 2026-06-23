const { Client } = require('pg');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    try {
        const { username, id_expediente, comentario } = JSON.parse(event.body);
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

        const checkOwner = await client.query(`SELECT e.id_expediente FROM expedientes e JOIN usuarios_sistema u ON e.id_firma = u.id_firma WHERE e.id_expediente = $1 AND u.username = $2`, [id_expediente, username]);
        if (checkOwner.rows.length === 0) throw new Error('Propiedad inválida');

        // Insertar comentario inyectando el 'creado_por'
        const insertQuery = `INSERT INTO seguimiento_expedientes (id_expediente, comentario, creado_por) VALUES ($1, $2, $3) RETURNING *`;
        const result = await client.query(insertQuery, [id_expediente, comentario, username]);

        await client.end();
        return { statusCode: 200, body: JSON.stringify({ success: true, comentario: result.rows[0] }) };
    } catch (error) { return { statusCode: 500, body: JSON.stringify({ error: 'Error al registrar seguimiento.' }) }; }
};