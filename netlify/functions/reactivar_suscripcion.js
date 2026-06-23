const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
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

        const res = await client.query('SELECT stripe_subscription_id FROM usuarios_sistema WHERE nombre_firma = $1', [username]);
        if (res.rows.length === 0 || !res.rows[0].stripe_subscription_id) throw new Error("No hay suscripción activa.");

        // Quitamos la bandera de cancelación en Stripe para que siga renovando
        await stripe.subscriptions.update(res.rows[0].stripe_subscription_id, { cancel_at_period_end: false });

        // Actualizamos la base de datos
        await client.query('UPDATE usuarios_sistema SET suscripcion_cancelada = false WHERE nombre_firma = $1', [username]);
        await client.end();

        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error) { return { statusCode: 500, body: JSON.stringify({ error: 'Error reactivando suscripción.' }) }; }
};