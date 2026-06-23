const { Client } = require('pg');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Método no permitido' }) };

    try {
        const { licencia } = JSON.parse(event.body);

        if (!licencia) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Código de licencia no proporcionado.' }) };
        }

        const client = new Client({
            connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED,
            ssl: { rejectUnauthorized: false }
        });
        await client.connect();

        // Buscamos la licencia asegurándonos de que exista y su estado 'usada' sea falso
        const query = 'SELECT dias_vigencia FROM licencias WHERE codigo = $1 AND usada = false';
        const res = await client.query(query, [licencia]);

        await client.end();

        if (res.rows.length > 0) {
            // Extraemos los días y se los enviamos al index.html
            const dias = res.rows[0].dias_vigencia;
            return {
                statusCode: 200,
                body: JSON.stringify({
                    success: true,
                    dias_vigencia: dias
                })
            };
        } else {
            // Si el código está mal escrito, o la columna 'usada' ya está en true
            return {
                statusCode: 400,
                body: JSON.stringify({
                    success: false,
                    error: 'La licencia ingresada no existe o ya fue utilizada en otra cuenta.'
                })
            };
        }

    } catch (error) {
        console.error('Error al validar licencia:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ success: false, error: 'Error del servidor al procesar la validación.' })
        };
    }
};