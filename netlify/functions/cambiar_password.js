const { Client } = require('pg');

exports.handler = async function (event) {
    // 1. Barrera de Método HTTP
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Método no permitido. Use POST.' }) };
    }

    try {
        const { usuarioActual, passwordActual, passwordNuevo } = JSON.parse(event.body);

        // 2. Validación de integridad de la petición
        if (!usuarioActual || !passwordActual || !passwordNuevo) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Todos los campos son obligatorios.' }) };
        }

        // 3. Conexión segura al motor de PostgreSQL
        const client = new Client({
            connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED,
            ssl: { rejectUnauthorized: false }
        });

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

        // 4. Auditoría de Credenciales (El Guardián)
        // Buscamos al usuario por su nombre_firma (que es lo que guardamos en localStorage) y verificamos su contraseña actual.
        const verifyQuery = 'SELECT username FROM usuarios_sistema WHERE nombre_firma = $1 AND password_hash = $2';
        const verifyResult = await client.query(verifyQuery, [usuarioActual, passwordActual]);

        if (verifyResult.rows.length === 0) {
            await client.end();
            return {
                statusCode: 401,
                body: JSON.stringify({ success: false, error: 'La contraseña actual ingresada es incorrecta. Operación denegada.' })
            };
        }

        // 5. Ejecución de la Mutación (Actualización)
        const updateQuery = 'UPDATE usuarios_sistema SET password_hash = $1 WHERE nombre_firma = $2';
        await client.query(updateQuery, [passwordNuevo, usuarioActual]);

        // 6. Cierre hermético de conexión
        await client.end();

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, message: 'Credenciales actualizadas con absoluta seguridad.' })
        };

    } catch (error) {
        console.error('Fallo estructural al modificar contraseña:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Error del servidor de base de datos durante la transacción.' })
        };
    }
};