const { Client } = require('pg');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    try {
        const { username, id_expediente, accion } = JSON.parse(event.body);
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

        // Si la acción es 'archivar', pone el estado y la fecha exacta. Si es 'restaurar', limpia los campos.
        const estado = accion === 'archivar' ? 'archivado' : 'activo';
        const fecha = accion === 'archivar' ? 'NOW()' : 'NULL';

        // Usamos un CTE (Common Table Expression) recursivo para archivar también a los "hijos" del expediente
        const query = `
            WITH RECURSIVE arbol AS (
                SELECT id_expediente FROM expedientes WHERE id_expediente = $1 AND username = $2
                UNION
                SELECT e.id_expediente FROM expedientes e INNER JOIN arbol a ON e.id_padre = a.id_expediente
            )
            UPDATE expedientes SET estado_archivo = '${estado}', fecha_archivo = ${fecha}
            WHERE id_expediente IN (SELECT id_expediente FROM arbol);
        `;

        await client.query(query, [id_expediente, username]);
        await client.end();
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Fallo al procesar el cambio de estado.' }) };
    }
};