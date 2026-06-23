const { Client } = require('pg');
const jwt = require('jsonwebtoken');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return { statusCode: 401, body: JSON.stringify({ error: 'Denegado' }) };
    try { jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); } catch (err) { return { statusCode: 401, body: JSON.stringify({ error: 'Token inválido' }) }; }

    let client;
    try {
        const parsedBody = JSON.parse(event.body);
        // Destructuramos todo desde el parsedBody
        const { username, accion, id_expediente, id_resolucion, payload, fecha_desde, fecha_hasta, contexto, cuaderno } = parsedBody;

        client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });
        await client.connect();

        const userRes = await client.query('SELECT id_firma, rol_equipo FROM usuarios_sistema WHERE username = $1', [username]);
        if (userRes.rows.length === 0) throw new Error('Usuario no encontrado');
        const id_firma = userRes.rows[0].id_firma;
        const isManager = (userRes.rows[0].rol_equipo === 'titular' || userRes.rows[0].rol_equipo === 'master');

        // ======================================================================
        // LISTAR EN EXPEDIENTE
        // ======================================================================
        if (accion === 'listar') {
            const cuadernoFiltro = cuaderno || 'Único';
            const res = await client.query(`
                SELECT * FROM resoluciones_expediente 
                WHERE id_expediente = $1 
                AND (cuaderno = $2 OR ($2 = 'Único' AND cuaderno = 'Principal') OR ($2 = 'Principal' AND cuaderno = 'Único'))
                ORDER BY fecha_publicacion DESC NULLS LAST, id_resolucion DESC
            `, [id_expediente, cuadernoFiltro]);
            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true, resoluciones: res.rows }) };
        }

        // ======================================================================
        // AGREGAR RESOLUCIÓN
        // ======================================================================
        else if (accion === 'agregar') {
            // Extraer los nuevos campos provisionales
            const esProvisional = payload.es_provisional || false;
            const motivoProv = payload.motivo_provisional || null;

            const resDB = await client.query(`
                INSERT INTO resoluciones_expediente 
                (id_expediente, tipo, fecha_resolucion, fecha_publicacion, comentario, cuaderno, tipo_notificacion, fecha_notificacion, creado_por, es_provisional, motivo_provisional) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                RETURNING id_resolucion
            `, [
                id_expediente, payload.tipo, payload.fecha || null, payload.fecha_publicacion, payload.comentario,
                payload.cuaderno || 'Principal', payload.tipo_notificacion, payload.fecha_notificacion || null, username,
                esProvisional, motivoProv
            ]);

            // AUTOMATIZACIÓN DE TAREA (Si es provisional)
            if (esProvisional) {
                const expInfo = await client.query('SELECT numero_expediente, tag_organo FROM expedientes WHERE id_expediente = $1', [id_expediente]);
                const expData = expInfo.rows[0];
                const tag = expData.tag_organo ? `[${expData.tag_organo}]` : '';
                const tituloTarea = `Exp. ${expData.numero_expediente} ${tag} | Tomar auto pendiente de fecha ${payload.fecha_publicacion}`;

                const [y, m, d] = payload.fecha_publicacion.split('-');
                let fechaVenc = new Date(y, m - 1, d);
                fechaVenc.setDate(fechaVenc.getDate() + 1);
                if (fechaVenc.getDay() === 6) fechaVenc.setDate(fechaVenc.getDate() + 2);
                else if (fechaVenc.getDay() === 0) fechaVenc.setDate(fechaVenc.getDate() + 1);
                const fechaVencStr = `${fechaVenc.getFullYear()}-${String(fechaVenc.getMonth() + 1).padStart(2, '0')}-${String(fechaVenc.getDate()).padStart(2, '0')}`;

                await client.query(`
                    INSERT INTO tareas_expediente (id_expediente, descripcion, fecha_vencimiento, categoria, estado, asignado_a, creado_por) 
                    VALUES ($1, $2, $3, 'Tribunal', 'pendiente', $4, $4)
                `, [id_expediente, tituloTarea, fechaVencStr, username]);
            }

            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true, id_resolucion: resDB.rows[0].id_resolucion }) };
        }

        // ======================================================================
        // EDITAR RESOLUCIÓN
        // ======================================================================
        else if (accion === 'editar') {
            await client.query(`
                UPDATE resoluciones_expediente 
                SET comentario = $1, tipo = $2, fecha_resolucion = $3, fecha_publicacion = $4, tipo_notificacion = $5, fecha_notificacion = $6
                WHERE id_resolucion = $7
            `, [payload.comentario, payload.tipo, payload.fecha, payload.fecha_publicacion, payload.tipo_notificacion, payload.fecha_notificacion, id_resolucion]);
            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // ======================================================================
        // ELIMINAR RESOLUCIÓN
        // ======================================================================
        else if (accion === 'eliminar') {
            await client.query('DELETE FROM resoluciones_expediente WHERE id_resolucion = $1', [id_resolucion]);
            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // ======================================================================
        // QUITAR ALERTA PROVISIONAL
        // ======================================================================
        else if (accion === 'quitar_provisional') {
            await client.query(`
                UPDATE resoluciones_expediente 
                SET es_provisional = false, motivo_provisional = null 
                WHERE id_resolucion = $1
            `, [id_resolucion]);

            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // ======================================================================
        // LISTAR BOLETÍN (POR DÍA)
        // ======================================================================
        else if (accion === 'listar_dia') {
            let filtroContexto = "";
            let queryParams = [id_firma, fecha_desde, username, fecha_hasta];

            const target = (isManager && contexto) ? contexto : username;

            if (target !== 'TODOS') {
                filtroContexto = `AND e.abogado_asignado = $5`;
                queryParams.push(target);
            }

            const res = await client.query(`
                SELECT r.*, e.cliente, e.numero_expediente, e.organo_jurisdiccional, e.abogado_asignado,
                CASE WHEN v.id_vista IS NOT NULL THEN true ELSE false END as vista_por_mi
                FROM resoluciones_expediente r
                JOIN expedientes e ON r.id_expediente = e.id_expediente
                LEFT JOIN resoluciones_vistas v ON r.id_resolucion = v.id_resolucion AND v.username = $3
                WHERE e.id_firma = $1 AND r.fecha_publicacion BETWEEN $2 AND $4 ${filtroContexto}
                ORDER BY r.fecha_publicacion DESC, e.cliente ASC, r.id_resolucion DESC
            `, queryParams);
            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true, resoluciones: res.rows }) };
        }

        // ======================================================================
        // MARCAR COMO VISTA (TOGGLE)
        // ======================================================================
        else if (accion === 'toggle_vista') {
            const check = await client.query('SELECT id_vista FROM resoluciones_vistas WHERE username = $1 AND id_resolucion = $2', [username, id_resolucion]);

            if (check.rows.length > 0) {
                await client.query('DELETE FROM resoluciones_vistas WHERE id_vista = $1', [check.rows[0].id_vista]);
                await client.end();
                return { statusCode: 200, body: JSON.stringify({ success: true, estado: 'no_vista' }) };
            } else {
                await client.query('INSERT INTO resoluciones_vistas (username, id_resolucion) VALUES ($1, $2)', [username, id_resolucion]);
                await client.end();
                return { statusCode: 200, body: JSON.stringify({ success: true, estado: 'vista' }) };
            }
        }

        await client.end();
        return { statusCode: 400, body: JSON.stringify({ error: 'Acción no válida' }) };

    } catch (error) {
        if (client) { try { await client.end(); } catch (e) { } }
        console.error(error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};