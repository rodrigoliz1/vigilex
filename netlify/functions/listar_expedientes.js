const { Client } = require('pg');
const jwt = require('jsonwebtoken');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    // --- BARRERA DE SEGURIDAD JWT ---
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return { statusCode: 401, body: JSON.stringify({ error: 'Denegado' }) };
    try { jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); } catch (err) { return { statusCode: 401, body: JSON.stringify({ error: 'Token inválido' }) }; }

    let client;
    try {
        const { username, contexto } = JSON.parse(event.body);
        client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });
        await client.connect();

        // 1. Identificar rol y firma
        const userRes = await client.query('SELECT id_firma, rol_equipo FROM usuarios_sistema WHERE username = $1', [username]);
        if (userRes.rows.length === 0) throw new Error('Usuario no encontrado');
        const { id_firma, rol_equipo } = userRes.rows[0];

        // 2. Extraer equipo (para los selectores)
        const equipoRes = await client.query('SELECT username, rol_equipo, nombre_real FROM usuarios_sistema WHERE id_firma = $1', [id_firma]);

        // 3. Extraer las carteras a las que estoy INVITADO
        const invitacionesRes = await client.query('SELECT propietario_cartera FROM accesos_cartera WHERE usuario_invitado = $1', [username]);
        const carterasPermitidas = invitacionesRes.rows.map(row => row.propietario_cartera);
        carterasPermitidas.push(username); // Siempre puedo ver la mía

        // 4. LÓGICA MULTI-CONTEXTO ELITE (El Muro de Privacidad)
        let expQuery = "";
        let queryParams = [];

        // Los Jefes (Master, Titular, Socio, Admin) tienen vista panorámica por defecto
        const esJefe = ['master', 'titular', 'socio', 'admin'].includes(rol_equipo);

        if (contexto === 'TODOS' || !contexto) {
            if (esJefe) {
                // JEFE: Ve todo lo de la firma, EXCEPTO lo privado de otros
                expQuery = `
                    SELECT * FROM expedientes 
                    WHERE id_firma = $1 
                    AND (es_privado = false OR abogado_asignado = $2)
                    ORDER BY cliente, id_padre NULLS FIRST
                `;
                queryParams = [id_firma, username];
            } else {
                // SUBORDINADO (Abogado, Asociado, Pasante): Solo ve lo suyo y lo de quienes lo invitaron
                // (Ocultando siempre lo privado de otros)
                expQuery = `
                    SELECT * FROM expedientes 
                    WHERE id_firma = $1 
                    AND abogado_asignado = ANY($2::text[])
                    AND (es_privado = false OR abogado_asignado = $3)
                    ORDER BY cliente, id_padre NULLS FIRST
                `;
                queryParams = [id_firma, carterasPermitidas, username];
            }
        } else {
            // Entrando a una CARTERA ESPECÍFICA
            if (esJefe || carterasPermitidas.includes(contexto)) {
                // Si tengo permiso de ver esta cartera (o soy jefe)
                expQuery = `
                    SELECT * FROM expedientes 
                    WHERE id_firma = $1 
                    AND abogado_asignado = $2 
                    AND (es_privado = false OR abogado_asignado = $3)
                    ORDER BY cliente, id_padre NULLS FIRST
                `;
                queryParams = [id_firma, contexto, username];
            } else {
                // Intento de hackeo/espionaje
                throw new Error("No tienes permisos para visualizar esta cartera operativa.");
            }
        }

        const expRes = await client.query(expQuery, queryParams);
        await client.end();

        return { statusCode: 200, body: JSON.stringify({ success: true, expedientes: expRes.rows, equipo: equipoRes.rows }) };

    } catch (error) {
        if (client) await client.end();
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};