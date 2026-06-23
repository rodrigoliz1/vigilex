const { google } = require('googleapis');
const { Client } = require('pg');

exports.handler = async function (event) {
    const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URL
    );

    // ====================================================================
    // CASO 1: EL FRONTEND PIDE LA URL PARA INICIAR SESIÓN
    // ====================================================================
    if (event.httpMethod === 'POST') {
        try {
            const { username } = JSON.parse(event.body);
            if (!username) return { statusCode: 400, body: JSON.stringify({ error: 'Username requerido' }) };

            const url = oauth2Client.generateAuthUrl({
                access_type: 'offline',
                prompt: 'consent',
                scope: ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/presentations', 'email'],
                state: username
            });

            return { statusCode: 200, body: JSON.stringify({ success: true, url: url }) };
        } catch (error) {
            return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
        }
    }

    // ====================================================================
    // CASO 2: GOOGLE RESPONDE Y NOS MANDA DE REGRESO AQUÍ (CALLBACK)
    // ====================================================================
    if (event.httpMethod === 'GET') {
        const code = event.queryStringParameters.code;
        const username = event.queryStringParameters.state;

        if (!code || !username) {
            return { statusCode: 400, body: 'Error: Faltan parámetros de Google.' };
        }

        let client;
        try {
            const { tokens } = await oauth2Client.getToken(code);
            oauth2Client.setCredentials(tokens);

            const oauth2 = google.oauth2({ auth: oauth2Client, version: 'v2' });
            const userInfo = await oauth2.userinfo.get();
            const googleEmail = userInfo.data.email;

            // PRIMERO abrimos la conexión a la Base de Datos
            client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });
            await client.connect();

            // AHORA SÍ guardamos los tokens, la fecha de expiración y el correo (todo en 1 paso)
            await client.query(`
                UPDATE usuarios_sistema 
                SET google_access_token = $1, 
                    google_refresh_token = COALESCE($2, google_refresh_token),
                    google_token_expiry = $3,
                    google_email = $4
                WHERE username = $5
            `, [tokens.access_token, tokens.refresh_token, tokens.expiry_date, googleEmail, username]);

            await client.end();

            // Redirigimos al lobby principal con la confirmación de éxito
            return {
                statusCode: 302,
                headers: {
                    Location: '/lobby.html?drive=conectado'
                }
            };

        } catch (error) {
            if (client) { try { await client.end(); } catch (e) { } }
            console.error("Error en Callback OAuth:", error);
            return { statusCode: 500, body: 'Error al autorizar con Google Drive.' };
        }
    }

    return { statusCode: 405, body: 'Método no permitido' };
};