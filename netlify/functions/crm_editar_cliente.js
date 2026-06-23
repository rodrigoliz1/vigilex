const { Client } = require('pg');
exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };
    try {
        const { username, clienteActual, nuevoCliente, accion } = JSON.parse(event.body);
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

        if (accion === 'editar') {
            await client.query(`UPDATE expedientes SET cliente = $1 WHERE cliente = $2 AND username = $3`, [nuevoCliente, clienteActual, username]);
        } else if (accion === 'archivar') {
            await client.query(`UPDATE expedientes SET estado_archivo = 'archivado', fecha_archivo = NOW() WHERE cliente = $1 AND username = $2`, [clienteActual, username]);
        } else if (accion === 'restaurar') {
            await client.query(`UPDATE expedientes SET estado_archivo = 'activo', fecha_archivo = NULL WHERE cliente = $1 AND username = $2`, [clienteActual, username]);
        } else if (accion === 'eliminar') {
            await client.query(`DELETE FROM expedientes WHERE cliente = $1 AND username = $2`, [clienteActual, username]);
        }

        await client.end();
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error) { return { statusCode: 500, body: JSON.stringify({ error: 'Error en mutación masiva.' }) }; }
};