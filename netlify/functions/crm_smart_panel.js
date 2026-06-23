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
        const body = JSON.parse(event.body);
        client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });
        await client.connect();

        // 1. EXTRAER TODO EL CONTEXTO DEL EXPEDIENTE (AHORA INCLUYE FECHAS DE SESIÓN)
        if (body.accion === 'obtener_todo') {
            const resPartes = await client.query(`SELECT * FROM expediente_partes WHERE id_expediente = $1 ORDER BY id_parte ASC`, [body.id_expediente]);
            const resAud = await client.query(`SELECT * FROM expediente_audiencias WHERE id_expediente = $1`, [body.id_expediente]);
            const resTextos = await client.query(`SELECT * FROM expediente_textos_clave WHERE id_expediente = $1 ORDER BY id_texto ASC`, [body.id_expediente]);
            const resGest = await client.query(`SELECT * FROM expediente_gestiones WHERE id_expediente = $1 ORDER BY id_gestion ASC`, [body.id_expediente]);

            // EXTRAEMOS LOS NUEVOS DATOS DE SESIÓN DE LA TABLA EXPEDIENTES
            const resExp = await client.query(`SELECT estado_suspension_provisional, fecha_listado_sesion, fecha_sesion, sentido_sesion FROM expedientes WHERE id_expediente = $1`, [body.id_expediente]);

            await client.end();
            return {
                statusCode: 200,
                body: JSON.stringify({
                    success: true,
                    partes: resPartes.rows,
                    audiencias: resAud.rows,
                    textos: resTextos.rows,
                    gestiones: resGest.rows,
                    estado_suspension: resExp.rows[0] ? resExp.rows[0].estado_suspension_provisional : null,
                    datos_expediente: resExp.rows[0] || {} // Enviamos todo el objeto extraído para el frontend
                })
            };
        }

        // --- NUEVAS ACCIONES DE LISTADO A SESIÓN ---
        if (body.accion === 'guardar_fechas_sesion') {
            // 1. Revisamos la BD para ver si el asunto ya tenía una fecha de listado previa
            const checkExp = await client.query('SELECT fecha_listado_sesion, abogado_asignado, numero_expediente FROM expedientes WHERE id_expediente=$1', [body.id_expediente]);
            const oldFecha = checkExp.rows[0] ? checkExp.rows[0].fecha_listado_sesion : null;
            const newFecha = body.fecha_listado;

            // 2. Guardamos las fechas actualizadas
            await client.query(`UPDATE expedientes SET fecha_listado_sesion=$1, fecha_sesion=$2 WHERE id_expediente=$3`, [newFecha || null, body.fecha_sesion || null, body.id_expediente]);

            // 3. AUTOMATIZACIÓN ELITE: Si antes no tenía fecha de listado y ahora sí le pusieron una
            if (!oldFecha && newFecha) {
                const asignado = checkExp.rows[0].abogado_asignado || body.username;

                // Calculamos el día hábil siguiente a la fecha del listado (Saltando Sábado y Domingo)
                let dateObj = new Date(newFecha + 'T12:00:00Z');
                do {
                    dateObj.setUTCDate(dateObj.getUTCDate() + 1);
                } while (dateObj.getUTCDay() === 0 || dateObj.getUTCDay() === 6); // 0 = Dom, 6 = Sáb

                const nextBusinessDay = dateObj.toISOString().split('T')[0];
                const expNum = checkExp.rows[0].numero_expediente || '';

                // Inyectamos la tarea automática en la categoría 'Tribunal'
                await client.query(`
                    INSERT INTO tareas_expediente (id_expediente, descripcion, fecha_vencimiento, categoria, creado_por, asignado_a)
                    VALUES ($1, 'Ir a litigar con Magistrados', $2, 'Tribunal', $3, $4)
                `, [body.id_expediente, nextBusinessDay, body.username, asignado]);

                // Generamos una alerta de sistema para avisarle al abogado
                await client.query(`
                    INSERT INTO notificaciones (username_destino, titulo, mensaje, tipo) 
                    VALUES ($1, '📌 Nueva Tarea Automática', $2, 'info')
                `, [asignado, `Se listó el Exp. ${expNum}. Tienes programado ir a litigar el ${nextBusinessDay}.`]);
            }

            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        if (body.accion === 'guardar_sentido_sesion') {
            await client.query(`UPDATE expedientes SET sentido_sesion=$1 WHERE id_expediente=$2`, [body.sentido_sesion, body.id_expediente]);
            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // --- GESTIÓN DE PRUEBAS Y AUDIENCIAS GENÉRICAS ---
        if (body.accion === 'obtener_pruebas') {
            const res = await client.query(`SELECT * FROM expediente_pruebas WHERE id_expediente = $1 ORDER BY fecha_hora ASC`, [body.id_expediente]);
            await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true, pruebas: res.rows }) };
        }

        if (body.accion === 'guardar_prueba') {
            const p = body.payload;
            if (p.id_prueba) {
                // Editar existente
                await client.query(`
                    UPDATE expediente_pruebas 
                    SET tipo_prueba=$1, fecha_hora=$2, ubicacion=$3, oferente=$4, contraparte_desahogo=$5, detalles_json=$6, notas=$7, historial_eventos=$8
                    WHERE id_prueba=$9
                `, [p.tipo_prueba, p.fecha_hora, p.ubicacion, p.oferente, p.contraparte_desahogo, JSON.stringify(p.detalles_json), p.notas, JSON.stringify(p.historial_eventos), p.id_prueba]);
            } else {
                // Nueva prueba
                await client.query(`
                    INSERT INTO expediente_pruebas (id_expediente, tipo_prueba, fecha_hora, ubicacion, oferente, contraparte_desahogo, detalles_json, notas, historial_eventos)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                `, [body.id_expediente, p.tipo_prueba, p.fecha_hora, p.ubicacion, p.oferente, p.contraparte_desahogo, JSON.stringify(p.detalles_json), p.notas, JSON.stringify(p.historial_eventos || [])]);
            }
            await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        if (body.accion === 'eliminar_prueba') {
            await client.query(`DELETE FROM expediente_pruebas WHERE id_prueba=$1`, [body.id_prueba]);
            await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // --- LÓGICA DE PARTES Y AUDIENCIAS ---
        if (body.accion === 'agregar_parte') { await client.query(`INSERT INTO expediente_partes (id_expediente, tipo_parte, nombre) VALUES ($1, $2, $3)`, [body.id_expediente, body.tipo_parte, body.nombre]); await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true }) }; }
        if (body.accion === 'editar_parte') { const p = body.payload; await client.query(`UPDATE expediente_partes SET nombre=$1, rep_legal=$2, fecha_emplazamiento=$3, inf_justificado_estado=$4, inf_justificado_fecha=$5, inf_justificado_sentido=$6, inf_previo_estado=$7, inf_previo_fecha=$8, inf_previo_sentido=$9 WHERE id_parte=$10`, [p.nombre, p.rep_legal || null, p.fecha_emplazamiento || null, p.inf_justificado_estado || 'PENDIENTE DE RENDIR', p.inf_justificado_fecha || null, p.inf_justificado_sentido || null, p.inf_previo_estado || 'PENDIENTE DE RENDIR', p.inf_previo_fecha || null, p.inf_previo_sentido || null, body.id_parte]); await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true }) }; }
        if (body.accion === 'set_rep_comun') { await client.query(`UPDATE expediente_partes SET es_rep_comun = FALSE WHERE id_expediente=$1 AND tipo_parte=$2`, [body.id_expediente, body.tipo_parte]); if (body.id_parte) await client.query(`UPDATE expediente_partes SET es_rep_comun = TRUE WHERE id_parte=$1`, [body.id_parte]); await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true }) }; }
        if (body.accion === 'eliminar_parte') { await client.query(`DELETE FROM expediente_partes WHERE id_parte=$1`, [body.id_parte]); await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true }) }; }

        if (body.accion === 'guardar_fecha_audiencia') {
            const checkAud = await client.query(`SELECT id_audiencia, historial_eventos FROM expediente_audiencias WHERE id_expediente=$1 AND tipo_audiencia=$2`, [body.id_expediente, body.tipo_audiencia]);

            if (checkAud.rows.length === 0) {
                // Es nueva
                await client.query(`INSERT INTO expediente_audiencias (id_expediente, tipo_audiencia, fecha_programada, historial_eventos) VALUES ($1, $2, $3, $4)`, [body.id_expediente, body.tipo_audiencia, body.fecha_programada, `[${body.historial_evento}]`]);
            } else {
                const idAud = checkAud.rows[0].id_audiencia;
                let hist = checkAud.rows[0].historial_eventos || [];

                // SOLO AGREGAMOS AL HISTORIAL SI NO ES CORRECCIÓN
                if (!body.es_correccion && body.historial_evento) {
                    hist.push(JSON.parse(body.historial_evento));
                }

                await client.query(`UPDATE expediente_audiencias SET fecha_programada=$1, historial_eventos=$2, estado='PROGRAMADA', sentido=NULL WHERE id_audiencia=$3`, [body.fecha_programada, JSON.stringify(hist), idAud]);
            }
            await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        if (body.accion === 'celebrar_audiencia') {
            // Recuperamos el historial actual para no borrarlo
            const checkAud = await client.query(`SELECT historial_eventos FROM expediente_audiencias WHERE id_expediente=$1 AND tipo_audiencia=$2`, [body.id_expediente, body.tipo_audiencia]);
            let hist = [];
            if (checkAud.rows.length > 0 && checkAud.rows[0].historial_eventos) hist = checkAud.rows[0].historial_eventos;

            // Inyectamos el evento de celebración
            hist.push({ fecha_registro: new Date().toISOString(), usuario: body.username, descripcion: `Se celebró la audiencia. Sentido de la resolución dictada: ${body.sentido}` });

            await client.query(`UPDATE expediente_audiencias SET estado='CELEBRADA', sentido=$1, fecha_programada=$2, historial_eventos=$3 WHERE id_expediente=$4 AND tipo_audiencia=$5`, [body.sentido, body.fecha_celebracion, JSON.stringify(hist), body.id_expediente, body.tipo_audiencia]);
            await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        if (body.accion === 'set_suspension') { await client.query(`UPDATE expedientes SET estado_suspension_provisional=$1 WHERE id_expediente=$2`, [body.estado, body.id_expediente]); await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true }) }; }

        // --- FASE 5: TEXTOS DINÁMICOS Y GESTIONES ---
        if (body.accion === 'agregar_texto') {
            await client.query(`INSERT INTO expediente_textos_clave (id_expediente, categoria, contenido) VALUES ($1, $2, $3)`, [body.id_expediente, body.categoria, body.contenido]);
            await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }
        if (body.accion === 'editar_texto') {
            await client.query(`UPDATE expediente_textos_clave SET contenido=$1 WHERE id_texto=$2`, [body.contenido, body.id_texto]);
            await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }
        if (body.accion === 'eliminar_texto') {
            await client.query(`DELETE FROM expediente_textos_clave WHERE id_texto=$1`, [body.id_texto]);
            await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // GESTIONES CHECKLIST
        if (body.accion === 'agregar_gestion') {
            await client.query(`INSERT INTO expediente_gestiones (id_expediente, categoria, descripcion) VALUES ($1, $2, $3)`, [body.id_expediente, body.categoria, body.descripcion]);
            await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }
        if (body.accion === 'toggle_gestion') {
            await client.query(`UPDATE expediente_gestiones SET completada = NOT completada WHERE id_gestion=$1`, [body.id_gestion]);
            await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }
        if (body.accion === 'eliminar_gestion') {
            await client.query(`DELETE FROM expediente_gestiones WHERE id_gestion=$1`, [body.id_gestion]);
            await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        await client.end(); return { statusCode: 400, body: JSON.stringify({ error: 'Acción no válida' }) };
    } catch (error) {
        if (client) { try { await client.end(); } catch (e) { } }
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};