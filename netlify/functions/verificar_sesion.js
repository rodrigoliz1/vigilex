const { Client } = require('pg');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Método no permitido' }) };

    try {
        const { usuarioActual } = JSON.parse(event.body);
        if (!usuarioActual) return { statusCode: 200, body: JSON.stringify({ valida: false }) };

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

        // LEFT JOIN para no bloquear cuentas viejas, y LOWER() para ignorar mayúsculas
        const query = `
            SELECT u.username, u.rol_equipo, f.fecha_expiracion
            FROM usuarios_sistema u
            LEFT JOIN firmas f ON u.id_firma = f.id_firma
            WHERE LOWER(u.username) = LOWER($1)
            LIMIT 1
        `;
        const res = await client.query(query, [usuarioActual]);
        await client.end();

        if (res.rows.length === 0) {
            return { statusCode: 200, body: JSON.stringify({ valida: false }) };
        }

        const user = res.rows[0];
        let expirada = false;

        if (user.fecha_expiracion) {
            const expDate = new Date(user.fecha_expiracion);
            const hoy = new Date();
            if (expDate < hoy) {
                expirada = true;
            }
        }

        const esAdmin = (user.username === 'master' || user.rol_equipo === 'master');

        if (expirada) {
            return { statusCode: 403, body: JSON.stringify({ valida: true, expirada: true, es_admin: esAdmin }) };
        }

        return { statusCode: 200, body: JSON.stringify({ valida: true, expirada: false, es_admin: esAdmin, rol: user.rol_equipo }) };

    } catch (error) {
        console.error("Error en verificar_sesion:", error);
        return { statusCode: 500, body: JSON.stringify({ valida: false, error: error.message }) };
    }
};