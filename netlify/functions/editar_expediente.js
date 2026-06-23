const { Client } = require('pg');
const jwt = require('jsonwebtoken');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Método no permitido' }) };

    // --- 1. BARRERA DE SEGURIDAD JWT (EL CADENERO) ---
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Acceso denegado. Token no proporcionado.' }) };
    }

    try {
        jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    } catch (err) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Acceso denegado. Token inválido o expirado.' }) };
    }
    // --------------------------------------------------

    let client;

    try {
        const body = JSON.parse(event.body);
        const {
            username, id_expediente, cliente, numero, organo, materia, color, id_padre, tag_organo, asignado,
            // Campos de la arquitectura inteligente
            via_procedimiento, tipo_amparo, subtipo_amparo, incidente_suspension, procedimiento_especial,
            // Campo de denominación y alerta
            denominacion, fecha_vencimiento_alerta,
            // --- NUEVO CAMPO: MODO PRIVADO ---
            es_privado
        } = body;

        client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });
        await client.connect();

        // Autenticación estructural
        const userRes = await client.query('SELECT id_firma FROM usuarios_sistema WHERE username = $1', [username]);
        if (userRes.rows.length === 0 || !userRes.rows[0].id_firma) {
            await client.end();
            return { statusCode: 403, body: JSON.stringify({ error: 'No tienes una firma asignada.' }) };
        }
        const idFirma = userRes.rows[0].id_firma;

        // Blindaje de UI: Color por defecto y Asignación
        const colorFinal = color || '#0a2540';
        const abogadoAsignadoFinal = asignado || username;

        // Actualización blindada con la nueva columna es_privado
        const queryText = `
            UPDATE expedientes 
            SET cliente = $1, 
                numero_expediente = $2, 
                organo_jurisdiccional = $3, 
                materia = $4, 
                color_tag = $5, 
                id_padre = $6, 
                tag_organo = $7, 
                abogado_asignado = $8,
                via_procedimiento = $9,
                tipo_amparo = $10,
                subtipo_amparo = $11,
                incidente_suspension = $12,
                procedimiento_especial = $13,
                denominacion = $14,
                fecha_vencimiento_alerta = $15,
                es_privado = $16
            WHERE id_expediente = $17 AND id_firma = $18
        `;

        const values = [
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
            denominacion || '',
            fecha_vencimiento_alerta || null,
            es_privado || false, // <-- GUARDAMOS SI ES PRIVADO
            id_expediente,
            idFirma
        ];

        await client.query(queryText, values);
        await client.end();

        return { statusCode: 200, body: JSON.stringify({ success: true }) };

    } catch (error) {
        // Cerramos la conexión de forma segura si hubo un fallo
        if (client) {
            try { await client.end(); } catch (e) { }
        }

        // Evitar que el usuario renombre un expediente con datos de otro existente
        if (error.code === '23505') {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Ya existe un expediente registrado con ese mismo número y órgano jurisdiccional.' }) };
        }

        console.error('Fallo al editar expediente:', error);
        return { statusCode: 500, body: JSON.stringify({ success: false, error: 'Error interno del servidor.' }) };
    }
};