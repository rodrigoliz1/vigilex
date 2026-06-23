const webpush = require('web-push');
const { Client } = require('pg');

// Configuramos las llaves maestras que pusiste en Netlify
webpush.setVapidDetails(
    'mailto:noreply@vigilex.mx',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
);

async function enviarPushVigilex(usernameDestino, titulo, cuerpo, urlFinal = '/mensajes.html') {
    const client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });
    
    try {
        await client.connect();
        // Buscamos todos los dispositivos (iPhone, Mac, etc.) que tenga registrados ese usuario
        const res = await client.query('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE username = $1', [usernameDestino]);
        await client.end();

        if (res.rows.length === 0) return; // Si no tiene dispositivos, no hacemos nada

        const payload = JSON.stringify({ title: titulo, body: cuerpo, url: urlFinal });

        // Disparamos la señal a todos sus aparatos
        for (const sub of res.rows) {
            const pushConfig = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
            try {
                await webpush.sendNotification(pushConfig, payload);
            } catch (err) {
                // Si Apple/Google dice que el usuario borró la app, podríamos borrarlo de la BD aquí
                console.log('Error enviando push a un dispositivo, posiblemente expiró.');
            }
        }
    } catch (e) {
        if (client) await client.end();
        console.error('Error en Push Helper:', e);
    }
}

module.exports = { enviarPushVigilex };