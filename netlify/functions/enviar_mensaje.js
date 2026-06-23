const { Client } = require('pg');
const jwt = require('jsonwebtoken');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };
    try {
        const authHeader = event.headers.authorization || event.headers.Authorization;
        jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    } catch (e) { return { statusCode: 401, body: JSON.stringify({ error: 'Token inválido' }) }; }

    let client;
    try {
        const { remitente, destinatario, contenido } = JSON.parse(event.body);
        client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });
        await client.connect();

        let targets = [];
        // Lógica: Si mandan la palabra 'TODOS' o un array que incluya 'TODOS'
        if (destinatario === 'TODOS' || (Array.isArray(destinatario) && destinatario.includes('TODOS'))) {
            const resUsers = await client.query('SELECT username FROM usuarios_sistema WHERE username != $1', [remitente]);
            targets = resUsers.rows.map(r => r.username);
        } else if (Array.isArray(destinatario)) {
            // Si mandan un array de usuarios específicos (ej. ['Felipe', 'Juan'])
            targets = destinatario;
        } else {
            targets = [destinatario];
        }

        const titulo = (destinatario === 'TODOS') ? '📢 Comunicado General' : '📢 Comunicado a Equipo';
        const prefijo = `De ${remitente}: `;
        const mensajeCompleto = prefijo + contenido;

        for (let target of targets) {
            await client.query(`
                INSERT INTO notificaciones (username_destino, titulo, mensaje, tipo) 
                VALUES ($1, $2, $3, 'info')
            `, [target, titulo, mensajeCompleto]);
        }

        await client.end();
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error) {
        if (client) { try { await client.end(); } catch (e) { } }
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};