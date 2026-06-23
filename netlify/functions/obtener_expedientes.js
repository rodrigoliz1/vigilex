const { Client } = require('pg');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    try {
        const { username } = JSON.parse(event.body);
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

        // 1. Identificamos a qué despacho pertenece el usuario
        const userQuery = 'SELECT id_firma, rol_equipo FROM usuarios_sistema WHERE username = $1';
        const userRes = await client.query(userQuery, [username]);

        if (userRes.rows.length === 0) {
            await client.end();
            return { statusCode: 404, body: JSON.stringify({ error: 'Usuario no identificado' }) };
        }

        const { id_firma, rol_equipo } = userRes.rows[0];

        // 2. Traemos todos los expedientes del despacho e incluimos el nombre del abogado asignado
        const expedientesQuery = `
            SELECT e.*, us.username as responsable 
            FROM expedientes e
            LEFT JOIN usuarios_sistema us ON e.abogado_asignado = us.username
            WHERE e.id_firma = $1
            ORDER BY e.fecha_creacion DESC
        `;
        const resExp = await client.query(expedientesQuery, [id_firma]);

        // 3. Traemos la lista de abogados del equipo para que el frontend pueda llenar el selector de asignación
        const equipoQuery = 'SELECT username FROM usuarios_sistema WHERE id_firma = $1 ORDER BY username ASC';
        const resEqu = await client.query(equipoQuery, [id_firma]);

        await client.end();

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                expedientes: resExp.rows,
                equipo: resEqu.rows, // Lista para el dropdown
                miRol: rol_equipo
            })
        };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};