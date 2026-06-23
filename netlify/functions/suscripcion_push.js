const { Client } = require('pg');
const jwt = require('jsonwebtoken');

exports.handler = async function(event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    try {
        const authHeader = event.headers.authorization || event.headers.Authorization;
        if (!authHeader) return { statusCode: 401, body: JSON.stringify({ error: 'No token' }) };
        jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);

        const { username, subscription } = JSON.parse(event.body);
        if (!subscription || !subscription.endpoint) return { statusCode: 400, body: 'Datos inválidos' };

        const client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });
        await client.connect();

        // Guardamos las llaves del dispositivo
        await client.query(`
            INSERT INTO push_subscriptions (username, endpoint, p256dh, auth) 
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (endpoint) DO NOTHING
        `, [username, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]);

        await client.end();
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};