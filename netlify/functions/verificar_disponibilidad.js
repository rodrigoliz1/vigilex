const { Client } = require('pg');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    const client = new Client({
        connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED,
        ssl: { rejectUnauthorized: false }
    });

    try {
        const { username, email } = JSON.parse(event.body);
        await client.connect();

        // Verificamos si el usuario o el correo ya existen en la base de datos
        const res = await client.query(
            'SELECT username FROM usuarios_sistema WHERE username = $1 OR email = $2',
            [username.trim(), email.trim()]
        );

        await client.end();

        if (res.rows.length > 0) {
            return {
                statusCode: 400,
                body: JSON.stringify({ success: false, error: 'El usuario o el correo ya están registrados en el sistema.' })
            };
        }

        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error) {
        if (client) await client.end();
        console.error("Error en verificar_disponibilidad:", error);
        return { statusCode: 500, body: JSON.stringify({ success: false, error: 'Error de servidor.' }) };
    }
};