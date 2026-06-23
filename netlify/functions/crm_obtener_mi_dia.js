const { Client } = require('pg');
const jwt = require('jsonwebtoken');

// DICCIONARIO DE JERARQUÍAS
const RANGOS = { 'master': 10, 'titular': 20, 'socio': 30, 'admin': 40, 'abogado': 40, 'asociado': 50, 'pasante': 60 };

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader) return { statusCode: 401, body: JSON.stringify({ error: 'Denegado' }) };
    try { jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); } catch (e) { return { statusCode: 401, body: JSON.stringify({ error: 'Token inválido' }) }; }

    let client;
    try {
        const { username, usuarioObjetivo, vista, contexto } = JSON.parse(event.body);
        client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });
        await client.connect();

        // 1. Obtener rango del solicitante
        const userRes = await client.query('SELECT id_firma, rol_equipo FROM usuarios_sistema WHERE username = $1', [username]);
        if (userRes.rows.length === 0) throw new Error('Usuario no encontrado');

        const idFirma = userRes.rows[0].id_firma;
        const miRol = userRes.rows[0].rol_equipo || 'abogado';
        const miRango = RANGOS[miRol] || 99;

        // 2. Determinar a quién estamos viendo con validación en Cascada
        let targetUser = usuarioObjetivo || username;

        if (targetUser !== 'TODOS' && targetUser !== 'PERSONAL_TITULAR' && targetUser !== username) {
            const targetRes = await client.query('SELECT rol_equipo FROM usuarios_sistema WHERE username = $1 AND id_firma = $2', [targetUser, idFirma]);
            if (targetRes.rows.length > 0) {
                const targetRango = RANGOS[targetRes.rows[0].rol_equipo] || 99;
                // Si el solicitante intenta espiar a alguien de igual o mayor poder, lo regresamos a sus propias tareas
                if (miRango >= targetRango) {
                    targetUser = username;
                }
            } else {
                targetUser = username;
            }
        }

        // 3. Obtener Tareas
        let queryText = "";
        let queryParams = [];

        // Lógica de filtrado por Cartera
        let baseConditions = `t.id_expediente IN (SELECT id_expediente FROM expedientes WHERE id_firma = $1)`;
        if (contexto && contexto !== 'TODOS') {
            baseConditions = `t.id_expediente IN (SELECT id_expediente FROM expedientes WHERE id_firma = $1 AND (abogado_asignado = '${contexto}' OR es_privado = false))`;
        }

        if (targetUser === 'TODOS') {
            queryText = `
                SELECT t.*, e.numero_expediente, e.abogado_asignado 
                FROM tareas_expediente t
                JOIN expedientes e ON t.id_expediente = e.id_expediente
                WHERE ${baseConditions}
                ORDER BY t.fecha_vencimiento ASC NULLS LAST
            `;
            queryParams = [idFirma];
        } else if (targetUser === 'PERSONAL_TITULAR') {
            queryText = `
                SELECT t.*, e.numero_expediente, e.abogado_asignado 
                FROM tareas_expediente t
                JOIN expedientes e ON t.id_expediente = e.id_expediente
                WHERE ${baseConditions} AND t.asignado_a = $2
                ORDER BY t.fecha_vencimiento ASC NULLS LAST
            `;
            queryParams = [idFirma, username];
        } else {
            // Tareas específicas del usuario solicitado (Yo o mi subordinado)
            queryText = `
                SELECT t.*, e.numero_expediente, e.abogado_asignado 
                FROM tareas_expediente t
                JOIN expedientes e ON t.id_expediente = e.id_expediente
                WHERE ${baseConditions} AND t.asignado_a = $2
                ORDER BY t.fecha_vencimiento ASC NULLS LAST
            `;
            queryParams = [idFirma, targetUser];
        }

        const resTasks = await client.query(queryText, queryParams);
        await client.end();

        return { statusCode: 200, body: JSON.stringify({ success: true, tareas: resTasks.rows, viendoA: targetUser }) };
    } catch (error) {
        if (client) await client.end();
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};