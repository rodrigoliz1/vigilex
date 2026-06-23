const { Client } = require('pg');
const jwt = require('jsonwebtoken');

// 👇 Importamos el motor centralizado de Brevo
const { enviarCorreoVigilex } = require('./utils/mailer_helper');
const { enviarPushVigilex } = require('./utils/push_helper');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };
    try {
        const authHeader = event.headers.authorization || event.headers.Authorization;
        if (!authHeader) return { statusCode: 401, body: JSON.stringify({ error: 'No token' }) };
        jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    } catch (e) { return { statusCode: 401, body: JSON.stringify({ error: 'Token inválido' }) }; }

    let client;
    try {
        const body = JSON.parse(event.body);
        client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });
        await client.connect();

        // -----------------------------------------------------
        // MÓDULOS DE RED VIGILEX (SOLICITUDES EXTERNAS)
        // -----------------------------------------------------
        if (body.accion === 'enviar_solicitud') {
            const dest = body.destino;
            const uRes = await client.query(`SELECT username, email FROM usuarios_sistema WHERE username = $1 OR email = $1 LIMIT 1`, [dest]);
            if (uRes.rows.length === 0) {
                await client.end(); return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Usuario o correo no encontrado en la Red VIGILEX.' }) };
            }
            const targetUser = uRes.rows[0].username;
            const targetEmail = uRes.rows[0].email;

            if (targetUser === body.username) {
                await client.end(); return { statusCode: 400, body: JSON.stringify({ success: false, error: 'No puedes enviarte una solicitud a ti mismo.' }) };
            }

            const cRes = await client.query(`SELECT estado FROM solicitudes_chat WHERE (remitente = $1 AND destinatario = $2) OR (remitente = $2 AND destinatario = $1)`, [body.username, targetUser]);
            if (cRes.rows.length > 0) {
                await client.end(); return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Ya existe una solicitud o conexión activa con este usuario.' }) };
            }

            await client.query(`INSERT INTO solicitudes_chat (remitente, destinatario) VALUES ($1, $2)`, [body.username, targetUser]);
            await client.query(`INSERT INTO notificaciones (username_destino, username, titulo, mensaje, tipo) VALUES ($1, 'Sistema', '🌐 Nueva Solicitud de Chat', $2 || ' quiere conectar contigo en la Red VIGILEX.', 'info')`, [targetUser, body.username]);

            // DISPARADOR DE CORREO: Solicitud Nueva (USANDO HELPER)
            if (targetEmail) {
                await enviarCorreoVigilex(
                    targetEmail,
                    "Tienes una nueva solicitud de conexión",
                    "🌐 Nueva Solicitud en VIGILEX Network",
                    `El usuario <b>@${body.username}</b> ha solicitado conectar contigo de forma segura mediante la red corporativa VIGILEX.<br><br>Al aceptar su solicitud, podrán intercambiar mensajes, documentos y audios con cifrado de extremo a extremo.`,
                    "Ver Solicitud", "https://vigilex.mx/mensajes.html"
                );
            }

            await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }
        else if (body.accion === 'listar_solicitudes') {
            const sRes = await client.query(`
                SELECT s.id_solicitud, s.remitente, u.nombre_real, u.nombre_firma 
                FROM solicitudes_chat s 
                JOIN usuarios_sistema u ON s.remitente = u.username 
                WHERE s.destinatario = $1 AND s.estado = 'pendiente'
            `, [body.username]);
            await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true, solicitudes: sRes.rows }) };
        }
        else if (body.accion === 'responder_solicitud') {
            const rRes = await client.query(`UPDATE solicitudes_chat SET estado = $1 WHERE id_solicitud = $2 AND destinatario = $3 RETURNING remitente`, [body.respuesta, body.id_solicitud, body.username]);
            if (rRes.rows.length > 0 && body.respuesta === 'aceptada') {
                const remitente = rRes.rows[0].remitente;
                await client.query(`INSERT INTO mensajes_chat (remitente, destinatario, mensaje, leido) VALUES ($1, $2, $3, FALSE)`, [body.username, remitente, "SYS_CLEAR:Solicitud aceptada. Ya están conectados en la Red VIGILEX."]);

                // DISPARADOR DE CORREO: Solicitud Aceptada (USANDO HELPER)
                const uRes = await client.query(`SELECT email FROM usuarios_sistema WHERE username = $1`, [remitente]);
                if (uRes.rows.length > 0 && uRes.rows[0].email) {
                    await enviarCorreoVigilex(
                        uRes.rows[0].email,
                        "¡Solicitud Aceptada!",
                        "✅ Conexión Establecida",
                        `El usuario <b>@${body.username}</b> ha aceptado tu solicitud de conexión. Ya puedes comunicarte con él a través de tu buzón en VIGILEX Network.`,
                        "Abrir Chat", "https://vigilex.mx/mensajes.html"
                    );
                }
            }
            await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // -----------------------------------------------------
        // MÓDULOS DE CHAT Y GRUPOS
        // -----------------------------------------------------
        else if (body.accion === 'listar_chats') {
            const resInd = await client.query(`
                WITH chats AS (
                    SELECT DISTINCT CASE WHEN remitente = $1 THEN destinatario ELSE remitente END AS contacto
                    FROM mensajes_chat 
                    WHERE (remitente = $1 OR destinatario = $1) AND id_grupo IS NULL
                )
                SELECT 
                    c.contacto, 
                    'individual' as tipo, 
                    NULL::integer as id_grupo,
                    (SELECT COUNT(*) FROM mensajes_chat WHERE destinatario = $1 AND remitente = c.contacto AND leido = false AND id_grupo IS NULL) as no_leidos,
                    (SELECT mensaje FROM mensajes_chat WHERE ((remitente = $1 AND destinatario = c.contacto) OR (remitente = c.contacto AND destinatario = $1)) AND id_grupo IS NULL ORDER BY fecha_envio DESC LIMIT 1) as ultimo_mensaje,
                    (SELECT remitente FROM mensajes_chat WHERE ((remitente = $1 AND destinatario = c.contacto) OR (remitente = c.contacto AND destinatario = $1)) AND id_grupo IS NULL ORDER BY fecha_envio DESC LIMIT 1) as ultimo_remitente,
                    (SELECT fecha_envio FROM mensajes_chat WHERE ((remitente = $1 AND destinatario = c.contacto) OR (remitente = c.contacto AND destinatario = $1)) AND id_grupo IS NULL ORDER BY fecha_envio DESC LIMIT 1) as ultima_fecha,
                    u.nombre_real
                FROM chats c
                LEFT JOIN usuarios_sistema u ON c.contacto = u.username
            `, [body.username]);

            const resGrp = await client.query(`
                SELECT g.nombre_grupo as contacto, 
                       'grupo' as tipo, 
                       g.id_grupo as id_grupo,
                       (SELECT COUNT(*) FROM mensajes_chat WHERE id_grupo = g.id_grupo AND remitente != $1 AND leido = false) as no_leidos, 
                       (SELECT mensaje FROM mensajes_chat WHERE id_grupo = g.id_grupo ORDER BY fecha_envio DESC LIMIT 1) as ultimo_mensaje,
                       (SELECT remitente FROM mensajes_chat WHERE id_grupo = g.id_grupo ORDER BY fecha_envio DESC LIMIT 1) as ultimo_remitente,
                       (SELECT fecha_envio FROM mensajes_chat WHERE id_grupo = g.id_grupo ORDER BY fecha_envio DESC LIMIT 1) as ultima_fecha,
                       NULL as nombre_real
                FROM chat_grupos g 
                JOIN chat_grupo_miembros m ON g.id_grupo = m.id_grupo 
                WHERE m.username = $1
            `, [body.username]);

            let chats = [...resInd.rows, ...resGrp.rows];
            chats.sort((a, b) => new Date(b.ultima_fecha || 0) - new Date(a.ultima_fecha || 0));

            await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true, chats: chats }) };
        }
        else if (body.accion === 'obtener_conversacion') {
            let res, miembros = [];
            if (body.tipo === 'grupo') {
                await client.query(`UPDATE mensajes_chat SET leido = TRUE WHERE id_grupo = $1 AND remitente != $2`, [body.id_grupo, body.username]);
                res = await client.query(`SELECT id_mensaje, remitente, mensaje, fecha_envio, leido, is_edited, is_deleted FROM mensajes_chat WHERE id_grupo = $1 ORDER BY fecha_envio ASC`, [body.id_grupo]);
                const mRes = await client.query(`SELECT username FROM chat_grupo_miembros WHERE id_grupo = $1`, [body.id_grupo]);
                miembros = mRes.rows.map(r => r.username);
            } else {
                await client.query(`UPDATE mensajes_chat SET leido = TRUE WHERE destinatario = $1 AND remitente = $2 AND id_grupo IS NULL`, [body.username, body.contacto]);
                res = await client.query(`SELECT id_mensaje, remitente, mensaje, fecha_envio, leido, is_edited, is_deleted FROM mensajes_chat WHERE ((remitente = $1 AND destinatario = $2) OR (remitente = $2 AND destinatario = $1)) AND id_grupo IS NULL ORDER BY fecha_envio ASC`, [body.username, body.contacto]);
            }
            await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true, mensajes: res.rows, miembros: miembros }) };
        }
        // -----------------------------------------------------
        // MÓDULOS DE CHAT Y GRUPOS
        // -----------------------------------------------------
        // ... (código de listar_chats y obtener_conversacion) ...

        else if (body.accion === 'enviar_mensaje') {
            if (body.tipo === 'grupo') {
                // 1. Guardar mensaje en la DB
                await client.query(`INSERT INTO mensajes_chat (remitente, id_grupo, mensaje) VALUES ($1, $2, $3)`, [body.username, body.id_grupo, body.mensaje]);

                // 2. BUSCAR MIEMBROS PARA PUSH (EXCEPTO YO)
                const miembrosRes = await client.query(`SELECT username FROM chat_grupo_miembros WHERE id_grupo = $1 AND username != $2`, [body.id_grupo, body.username]);

                // 3. MANDAR PUSH A TODO EL GRUPO
                for (const m of miembrosRes.rows) {
                    await enviarPushVigilex(
                        m.username,
                        `${body.nombre_grupo || 'VIGILEX Grupo'}`,
                        `@${body.username}: ${body.mensaje.replace(/IMG::.*|DOC::.*/, '📎 Archivo adjunto')}`
                    );
                }

            } else {
                // 1. Guardar mensaje individual
                await client.query(`INSERT INTO mensajes_chat (remitente, destinatario, mensaje) VALUES ($1, $2, $3)`, [body.username, body.contacto, body.mensaje]);

                // 2. DISPARAR PUSH AL IPHONE/MAC (Instante cero)
                await enviarPushVigilex(
                    body.contacto,
                    `Nuevo mensaje de @${body.username}`,
                    body.mensaje.replace(/IMG::.*|DOC::.*/, '📎 Archivo adjunto')
                );

                // 3. DISPARADOR DE CORREO: Alerta de mensajes acumulados (Cada 5)
                const unreadRes = await client.query(`SELECT COUNT(*) as total FROM mensajes_chat WHERE destinatario = $1 AND remitente = $2 AND leido = false AND id_grupo IS NULL`, [body.contacto, body.username]);
                const countNoLeidos = parseInt(unreadRes.rows[0].total);

                if (countNoLeidos > 0 && countNoLeidos % 5 === 0) {
                    const uRes = await client.query(`SELECT email FROM usuarios_sistema WHERE username = $1`, [body.contacto]);
                    if (uRes.rows.length > 0 && uRes.rows[0].email) {
                        await enviarCorreoVigilex(
                            uRes.rows[0].email,
                            `Tienes ${countNoLeidos} mensajes sin leer`,
                            "💬 Mensajes Pendientes",
                            `Tienes <b>${countNoLeidos} mensajes sin leer</b> de <b>@${body.username}</b>.<br><br>Responde desde VIGILEX Network.`,
                            "Responder ahora", "https://vigilex.mx/mensajes.html"
                        );
                    }
                }
            }
            await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }
        else if (body.accion === 'crear_grupo') {
            const gRes = await client.query(`INSERT INTO chat_grupos (nombre_grupo, creado_por) VALUES ($1, $2) RETURNING id_grupo`, [body.nombre_grupo, body.username]);
            const idG = gRes.rows[0].id_grupo;
            for (let m of body.miembros) { await client.query(`INSERT INTO chat_grupo_miembros (id_grupo, username) VALUES ($1, $2)`, [idG, m]); }
            await client.query(`INSERT INTO mensajes_chat (remitente, id_grupo, mensaje, leido) VALUES ($1, $2, $3, TRUE)`, [body.username, idG, "SYS_GROUP:" + body.tombstone]);
            await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true, id_grupo: idG }) };
        }
        else if (body.accion === 'editar_grupo') {
            await client.query(`UPDATE chat_grupos SET nombre_grupo = $1 WHERE id_grupo = $2`, [body.nombre_grupo, body.id_grupo]);
            await client.query(`DELETE FROM chat_grupo_miembros WHERE id_grupo = $1`, [body.id_grupo]);
            for (let m of body.miembros) { await client.query(`INSERT INTO chat_grupo_miembros (id_grupo, username) VALUES ($1, $2)`, [body.id_grupo, m]); }
            await client.query(`INSERT INTO mensajes_chat (remitente, id_grupo, mensaje, leido) VALUES ($1, $2, $3, TRUE)`, [body.username, body.id_grupo, "SYS_GROUP:" + body.tombstone]);
            await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }
        else if (body.accion === 'editar_mensaje') {
            await client.query(`UPDATE mensajes_chat SET mensaje = $1, is_edited = TRUE WHERE id_mensaje = $2 AND remitente = $3`, [body.nuevo_texto, body.id_mensaje, body.username]);
            await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }
        else if (body.accion === 'eliminar_mensaje') {
            await client.query(`UPDATE mensajes_chat SET mensaje = $1, is_deleted = TRUE WHERE id_mensaje = $2 AND remitente = $3`, [body.texto_tombstone, body.id_mensaje, body.username]);
            await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }
        else if (body.accion === 'vaciar_chat') {
            if (body.tipo === 'grupo') {
                await client.query(`DELETE FROM mensajes_chat WHERE id_grupo = $1`, [body.id_grupo]);
                await client.query(`INSERT INTO mensajes_chat (remitente, id_grupo, mensaje, leido) VALUES ($1, $2, $3, TRUE)`, [body.username, body.id_grupo, "SYS_CLEAR:" + body.texto_tombstone]);
            } else {
                await client.query(`DELETE FROM mensajes_chat WHERE ((remitente = $1 AND destinatario = $2) OR (remitente = $2 AND destinatario = $1)) AND id_grupo IS NULL`, [body.username, body.contacto]);
                await client.query(`INSERT INTO mensajes_chat (remitente, destinatario, mensaje, leido) VALUES ($1, $2, $3, TRUE)`, [body.username, body.contacto, "SYS_CLEAR:" + body.texto_tombstone]);
            }
            await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }
        else if (body.accion === 'eliminar_grupo') {
            await client.query(`DELETE FROM chat_grupos WHERE id_grupo = $1`, [body.id_grupo]);
            await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        await client.end(); return { statusCode: 400, body: JSON.stringify({ error: 'Acción no válida' }) };
    } catch (error) {
        if (client) { try { await client.end(); } catch (e) { } }
        console.error("Error backend:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};