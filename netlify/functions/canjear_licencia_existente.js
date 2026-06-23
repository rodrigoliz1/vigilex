const { Client } = require('pg');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    try {
        const { username, password, licencia } = JSON.parse(event.body);
        const client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });
        await client.connect();

        const userQuery = 'SELECT username, id_firma FROM usuarios_sistema WHERE username = $1 AND password_hash = $2';
        const userRes = await client.query(userQuery, [username.trim(), password]);

        if (userRes.rows.length === 0) {
            await client.end();
            return { statusCode: 401, body: JSON.stringify({ error: 'Usuario o contraseña incorrectos.' }) };
        }

        const idFirma = userRes.rows[0].id_firma;

        const licQuery = 'SELECT dias_vigencia FROM licencias WHERE codigo = $1';
        const licRes = await client.query(licQuery, [licencia]);

        if (licRes.rows.length === 0) {
            await client.end();
            return { statusCode: 400, body: JSON.stringify({ error: 'La licencia es inválida o ya fue utilizada.' }) };
        }

        const dias = parseInt(licRes.rows[0].dias_vigencia);

        // ACTUALIZACIÓN CORREGIDA: Se inyectan los días a la firma
        const updateQuery = `
            UPDATE firmas 
            SET fecha_expiracion = CASE 
                WHEN fecha_expiracion > CURRENT_DATE THEN fecha_expiracion + (CAST($1 AS INTEGER) * INTERVAL '1 day')
                ELSE CURRENT_DATE + (CAST($1 AS INTEGER) * INTERVAL '1 day')
            END
            WHERE id_firma = $2
            RETURNING fecha_expiracion
        `;
        const updateRes = await client.query(updateQuery, [dias, idFirma]);

        await client.query('DELETE FROM licencias WHERE codigo = $1', [licencia]);
        await client.end();

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                dias_agregados: dias,
                nueva_expiracion: updateRes.rows[0].fecha_expiracion,
                username: username // Devolvemos el username real
            })
        };

    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Error interno de base de datos al procesar el canje.' }) };
    }
};