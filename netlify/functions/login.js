const { Client } = require('pg');
const bcrypt = require('bcryptjs'); // <-- Encriptación
const jwt = require('jsonwebtoken'); // <-- Generador de Tokens (Gafetes)

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    try {
        const { username, password } = JSON.parse(event.body);
        const client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });
        await client.connect();

        // 1. Búsqueda insensible a mayúsculas (acepta correo o usuario)
        const query = `
            SELECT * FROM usuarios_sistema 
            WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1)
        `;
        const res = await client.query(query, [username.trim()]);

        if (res.rows.length === 0) {
            await client.end();
            return { statusCode: 401, body: JSON.stringify({ error: 'Credenciales incorrectas' }) };
        }

        const user = res.rows[0];
        let isValidPassword = false;

        // --- 2. MIGRACIÓN SILENCIOSA Y VALIDACIÓN ---
        if (user.password_hash === password) {
            // El usuario aún tiene la contraseña en texto plano y acertó.
            isValidPassword = true;

            // ¡Lo migramos en secreto! Hasheamos su contraseña y la actualizamos.
            const salt = await bcrypt.genSalt(10);
            const newHashedPassword = await bcrypt.hash(password, salt);
            await client.query('UPDATE usuarios_sistema SET password_hash = $1 WHERE username = $2', [newHashedPassword, user.username]);

        } else {
            // El usuario ya fue migrado, validamos con criptografía real
            isValidPassword = await bcrypt.compare(password, user.password_hash);
        }

        if (!isValidPassword) {
            await client.end();
            return { statusCode: 401, body: JSON.stringify({ error: 'Credenciales incorrectas' }) };
        }

        // --- 3. GENERACIÓN DEL TOKEN JWT (EL GAFETE DIGITAL) ---
        const tokenPayload = {
            username: user.username,
            id_firma: user.id_firma,
            rol: user.rol_equipo
        };

        // Firmamos el token por 8 horas. 
        // IMPORTANTE: Asegúrate de crear la variable JWT_SECRET en Netlify
        const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, { expiresIn: '8h' });


        // --- 4. LÓGICA DE ONBOARDING ---
        const esTitularOMaster = (user.rol_equipo === 'titular' || user.rol_equipo === 'master');
        const necesitaConfirmar = esTitularOMaster ? false : (user.correo_confirmado === false);
        const necesitaCambiarPass = esTitularOMaster ? false : (user.requiere_cambio_pass === true);

        await client.end();

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                username: user.username,
                token: token, // <-- ENVIAMOS EL TOKEN AL FRONTEND
                necesitaConfirmar: necesitaConfirmar,
                necesitaCambiarPass: necesitaCambiarPass
            })
        };

    } catch (error) {
        console.error("Error en login:", error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Error interno del servidor.' }) };
    }
};