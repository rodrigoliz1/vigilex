const { Client } = require('pg');
const jwt = require('jsonwebtoken');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Método no permitido' }) };

    // --- BARRERA DE SEGURIDAD JWT ---
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return { statusCode: 401, body: JSON.stringify({ error: 'Acceso denegado. Token no proporcionado.' }) };
    try { jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); } catch (err) { return { statusCode: 401, body: JSON.stringify({ error: 'Token inválido o expirado.' }) }; }

    let client;

    try {
        const body = JSON.parse(event.body);
        const {
            username, cliente, numero, organo, materia, color, id_padre, tag_organo, asignado,
            // --- CAMPOS EXTRAÍDOS DEL SÚPER-FORMULARIO ---
            via_procedimiento, tipo_amparo, subtipo_amparo, incidente_suspension, procedimiento_especial,
            // --- ALERTAS Y MODO PRIVADO ---
            fecha_vencimiento_alerta,
            es_privado // <-- NUEVO CAMPO DE PRIVACIDAD
        } = body;

        client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });
        await client.connect();

        const userRes = await client.query('SELECT id_firma FROM usuarios_sistema WHERE username = $1', [username]);
        if (userRes.rows.length === 0 || !userRes.rows[0].id_firma) {
            await client.end();
            return { statusCode: 403, body: JSON.stringify({ error: 'Usuario no vinculado a una firma corporativa.' }) };
        }

        const idFirma = userRes.rows[0].id_firma;
        const abogadoAsignadoFinal = asignado || username;
        const colorFinal = color || '#0a2540';

        // --- INYECCIÓN SQL ACTUALIZADA (AHORA CON ES_PRIVADO) ---
        const queryText = `
            INSERT INTO expedientes 
            (id_firma, username, cliente, numero_expediente, organo_jurisdiccional, materia, color_tag, id_padre, tag_organo, abogado_asignado, estado_archivo, via_procedimiento, tipo_amparo, subtipo_amparo, incidente_suspension, procedimiento_especial, fecha_vencimiento_alerta, es_privado)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'activo', $11, $12, $13, $14, $15, $16, $17)
            RETURNING id_expediente;
        `;

        const values = [
            idFirma,
            username,
            cliente,
            numero,
            organo,
            materia,
            colorFinal,
            id_padre || null,
            tag_organo || '',
            abogadoAsignadoFinal,
            via_procedimiento || '',
            tipo_amparo || '',
            subtipo_amparo || '',
            incidente_suspension || false,
            procedimiento_especial || '',
            fecha_vencimiento_alerta || null,
            es_privado || false // <-- GUARDAMOS SI ES PRIVADO O NO
        ];

        const res = await client.query(queryText, values);
        await client.end();

        return { statusCode: 200, body: JSON.stringify({ success: true, id_expediente: res.rows[0].id_expediente }) };

    } catch (error) {
        if (client) {
            try { await client.end(); } catch (e) { }
        }
        if (error.code === '23505') {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Ya existe un expediente registrado con ese mismo número y órgano jurisdiccional.' }) };
        }
        console.error('Fallo al agregar expediente:', error);
        return { statusCode: 500, body: JSON.stringify({ success: false, error: 'Error interno del servidor.' }) };
    }
};