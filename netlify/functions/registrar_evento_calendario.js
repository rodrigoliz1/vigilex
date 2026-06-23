const { Client } = require('pg');
const jwt = require('jsonwebtoken');

exports.handler = async function (event, context) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Método no permitido.' }) };

    // --- BARRERA DE SEGURIDAD JWT ---
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return { statusCode: 401, body: JSON.stringify({ error: 'Acceso denegado.' }) };
    try { jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); } catch (err) { return { statusCode: 401, body: JSON.stringify({ error: 'Token inválido.' }) }; }

    try {
        const payload = JSON.parse(event.body);
        const {
            username, materia, fechaInicio, fechaFin, detalle, tipoVinculo,
            idExpedienteExistente, nuevoExpNumero, nuevoExpMateria, nuevoExpOrgano,
            destino_calendario, asignado_a, concepto
        } = payload;

        if (!username || !materia || !fechaInicio || !fechaFin) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Datos de cálculo incompletos.' }) };
        }

        const client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });
        await client.connect();

        const userRes = await client.query('SELECT id_firma FROM usuarios_sistema WHERE username = $1', [username]);
        if (userRes.rows.length === 0) {
            await client.end();
            return { statusCode: 403, body: JSON.stringify({ error: 'Usuario no vinculado a una firma.' }) };
        }

        const idFirma = userRes.rows[0].id_firma;
        let idExpedienteFinal = null;

        // VINCULACIÓN AL EXPEDIENTE
        if (tipoVinculo === 'expediente') {
            if (idExpedienteExistente) {
                idExpedienteFinal = parseInt(idExpedienteExistente);
            } else if (nuevoExpNumero && nuevoExpOrgano && nuevoExpMateria) {
                const queryInsertExp = `
                    INSERT INTO expedientes (id_firma, username, numero_expediente, organo_jurisdiccional, materia, estado_archivo) 
                    VALUES ($1, $2, $3, $4, $5, 'activo')
                    ON CONFLICT (username, numero_expediente, organo_jurisdiccional) DO NOTHING
                    RETURNING id_expediente;
                `;
                const resExp = await client.query(queryInsertExp, [idFirma, username, nuevoExpNumero, nuevoExpOrgano, nuevoExpMateria]);

                if (resExp.rows.length > 0) {
                    idExpedienteFinal = resExp.rows[0].id_expediente;
                } else {
                    const resExistente = await client.query('SELECT id_expediente FROM expedientes WHERE username = $1 AND numero_expediente = $2 AND organo_jurisdiccional = $3', [username, nuevoExpNumero, nuevoExpOrgano]);
                    if (resExistente.rows.length > 0) idExpedienteFinal = resExistente.rows[0].id_expediente;
                }
            }
        }

        // GUARDADO EN LA BITÁCORA
        const tituloCompuesto = concepto || materia;
        const queryInsertCalculo = `
            INSERT INTO bitacora_calculos (username, materia, fecha_inicio, fecha_fin, detalle, id_expediente) 
            VALUES ($1, $2, $3, $4, $5, $6) 
            RETURNING id_calculo;
        `;
        await client.query(queryInsertCalculo, [username, tituloCompuesto, fechaInicio, fechaFin, detalle, idExpedienteFinal]);

        // GUARDADO EN CALENDARIO Y TAREAS (Si aplica)
        const tituloEvento = `PLAZO: ${tituloCompuesto}`;
        if (destino_calendario === 'institucional' || destino_calendario === 'ambos') {
            await client.query(`INSERT INTO eventos_calendario (username, titulo_evento, fecha_vencimiento, tipo_calendario, creado_por, todo_el_dia) VALUES ($1, $2, $3, 'institucional', $1, true)`, [username, tituloEvento, fechaFin]);
        }
        if (destino_calendario === 'personal' || destino_calendario === 'ambos') {
            await client.query(`INSERT INTO eventos_calendario (username, titulo_evento, fecha_vencimiento, tipo_calendario, creado_por, todo_el_dia) VALUES ($1, $2, $3, 'personal', $1, true)`, [username, tituloEvento, fechaFin]);
        }
        if (idExpedienteFinal && asignado_a) {
            await client.query(`INSERT INTO tareas_expediente (id_expediente, descripcion, fecha_vencimiento, categoria, creado_por, asignado_a) VALUES ($1, $2, $3, 'Tribunal', $4, $5)`, [idExpedienteFinal, tituloEvento, fechaFin, username, asignado_a]);
        }

        await client.end();
        return { statusCode: 200, body: JSON.stringify({ success: true, message: 'Cálculo registrado con éxito.' }) };

    } catch (error) {
        console.error("Error en registrar_calculo:", error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Error interno en el motor de registro.' }) };
    }
};