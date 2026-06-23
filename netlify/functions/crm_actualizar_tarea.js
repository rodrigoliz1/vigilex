const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

const RANGOS = { 'master': 10, 'titular': 20, 'socio': 30, 'admin': 40, 'abogado': 40, 'asociado': 50, 'pasante': 60 };

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader) return { statusCode: 401, body: JSON.stringify({ error: 'No token' }) };
    try { jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); } catch (e) { return { statusCode: 401, body: JSON.stringify({ error: 'Invalid' }) }; }

    let client;
    try {
        const { username, id_tarea, nuevo_estado, sincronizar_vinculos, comentario_correccion } = JSON.parse(event.body);
        client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });
        await client.connect();

        const userRes = await client.query('SELECT rol_equipo, id_firma, email, nombre_real FROM usuarios_sistema WHERE username = $1', [username]);
        if (userRes.rows.length === 0) throw new Error('Usuario no encontrado');

        const miRol = userRes.rows[0].rol_equipo;
        const miRango = RANGOS[miRol] || 99;
        const id_firma = userRes.rows[0].id_firma;

        const resTask = await client.query(`
            SELECT t.descripcion, t.id_expediente, t.fecha_vencimiento, t.categoria, t.estado, t.asignado_a, e.numero_expediente, e.abogado_asignado 
            FROM tareas_expediente t
            LEFT JOIN expedientes e ON t.id_expediente = e.id_expediente
            WHERE t.id_tarea = $1
        `, [id_tarea]);
        if (resTask.rows.length === 0) throw new Error('Tarea no encontrada');

        const { descripcion, id_expediente, fecha_vencimiento, categoria, estado: estadoActual, asignado_a, numero_expediente, abogado_asignado } = resTask.rows[0];

        const esPlazo = descripcion.includes('PLAZO:');
        const conceptoLimpio = descripcion.replace('✅', '').replace('PLAZO:', '').trim();
        const numExp = numero_expediente || 'Sin Exp';

        // LÓGICA DE PERMISOS: Un usuario puede aprobar si es Jefe General (<=30) o si es el dueño de la cartera
        const puedeRevisar = (miRango <= 30) || (abogado_asignado === username);

        let descripcionNueva = descripcion.replace('✅ ', '').replace('✅', '').replace('Revisado, listo para presentar: ', '').replace('PARA CORRECCIÓN: ', '').trim();
        let finalEstado = nuevo_estado;
        let finalCategoria = categoria;
        let accionHistorial = "Cambió estado a " + nuevo_estado;

        let accionAuditoria = null;

        if (nuevo_estado === 'aprobar_revision') {
            if (!puedeRevisar) throw new Error('Permisos insuficientes para aprobar esta tarea.');
            finalEstado = 'pendiente'; finalCategoria = 'Tribunal';
            descripcionNueva = `Revisado, listo para presentar: ${descripcionNueva}`;
            accionHistorial = "✅ Aprobó el escrito y lo envió a Tribunal";
            accionAuditoria = 'A Presentar';
        } else if (nuevo_estado === 'rechazar_revision') {
            if (!puedeRevisar) throw new Error('Permisos insuficientes para rechazar esta tarea.');
            finalEstado = 'pendiente'; finalCategoria = 'Escritorio';
            descripcionNueva = `PARA CORRECCIÓN: ${descripcionNueva}`;
            accionHistorial = "❌ Rechazó el escrito y solicitó correcciones";
            accionAuditoria = 'A Corregir';
        } else if (nuevo_estado === 'realizada') {
            if (categoria === 'Escritorio' && estadoActual === 'pendiente') {
                finalEstado = 'en_revision'; accionHistorial = "⏳ Envió el escrito a Mesa de Revisión";
                accionAuditoria = 'A Revisión';
            } else {
                finalEstado = 'realizada'; descripcionNueva = `✅ ${descripcionNueva}`; accionHistorial = "✅ Marcó la tarea como completada";
                accionAuditoria = 'Completada';
            }
        } else if (nuevo_estado === 'pendiente') {
            if (estadoActual === 'en_revision' && puedeRevisar) {
                finalEstado = 'pendiente'; accionHistorial = "↩️ Retiró el escrito de Mesa de Revisión";
            } else {
                finalEstado = 'pendiente'; accionHistorial = "🔄 Reabrió la tarea (Pendiente)";
            }
        }

        // ==========================================
        // INICIO DE LA TRANSACCIÓN DEL CRM
        // ==========================================
        await client.query('BEGIN');

        await client.query(`UPDATE tareas_expediente SET estado = $1, descripcion = $2, fecha_completada = $3, categoria = $4 WHERE id_tarea = $5`, [finalEstado, descripcionNueva, finalEstado === 'realizada' ? 'NOW()' : null, finalCategoria, id_tarea]);
        await client.query(`INSERT INTO historial_tareas (id_tarea, username, accion) VALUES ($1, $2, $3)`, [id_tarea, username, accionHistorial]);

        if (nuevo_estado === 'rechazar_revision' && comentario_correccion) {
            await client.query(`INSERT INTO comentarios_tarea (id_tarea, username, comentario, es_revision) VALUES ($1, $2, $3, true)`, [id_tarea, username, comentario_correccion]);
        }

        if (esPlazo && (finalEstado === 'pendiente' || finalEstado === 'realizada' || sincronizar_vinculos === true)) {
            const agotadoStatus = (finalEstado === 'realizada');
            await client.query(`UPDATE bitacora_calculos SET agotado = $1 WHERE id_expediente = $2 AND materia = $3 AND fecha_fin = $4`, [agotadoStatus, id_expediente, conceptoLimpio, fecha_vencimiento]);
            let tituloCalendarioNuevo = `PLAZO: ${conceptoLimpio}`;
            if (agotadoStatus) tituloCalendarioNuevo = `✅ ${tituloCalendarioNuevo}`;
            await client.query(`UPDATE eventos_calendario SET titulo_evento = $1 WHERE (username = $2 OR creado_por = $2) AND fecha_vencimiento = $3 AND titulo_evento ILIKE $4`, [tituloCalendarioNuevo, username, fecha_vencimiento, `%PLAZO:%${conceptoLimpio}%`]);
        }

        await client.query('COMMIT');
        // ==========================================


        // =========================================================
        // INYECCIÓN VIGISCORE (POST-COMMIT)
        // =========================================================
        if (accionAuditoria) {
            try {
                await client.query(`
                    CREATE TABLE IF NOT EXISTS auditoria_tareas (
                        id_auditoria SERIAL PRIMARY KEY, id_firma VARCHAR(255), numero_expediente VARCHAR(100), nombre_tarea VARCHAR(255), abogado VARCHAR(100), accion VARCHAR(50), fecha_accion TIMESTAMP DEFAULT CURRENT_TIMESTAMP, fecha_vencimiento_tarea TIMESTAMP
                    );
                `);
                await client.query(`
                    INSERT INTO auditoria_tareas (id_firma, numero_expediente, nombre_tarea, abogado, accion, fecha_vencimiento_tarea)
                    VALUES ($1, $2, $3, $4, $5, $6)
                `, [String(id_firma), numExp, conceptoLimpio, asignado_a || username, accionAuditoria, fecha_vencimiento || null]);
            } catch (errAnalytics) { console.error("Métrica ignorada: ", errAnalytics.message); }
        }

        // ==========================================
        // NOTIFICACIONES ADAPTADAS A LA CASCADA
        // ==========================================
        try {
            if (nuevo_estado === 'aprobar_revision' && asignado_a) {
                await client.query(`INSERT INTO notificaciones (username_destino, titulo, mensaje, tipo) VALUES ($1, '✅ Escrito Aprobado', $2, 'info')`, [asignado_a, `Tu escrito ha sido aprobado y enviado a Tribunal: ${conceptoLimpio}`]);
            }
            else if (nuevo_estado === 'rechazar_revision' && asignado_a) {
                await client.query(`INSERT INTO notificaciones (username_destino, titulo, mensaje, tipo) VALUES ($1, '❌ Correcciones Solicitadas', $2, 'info')`, [asignado_a, `Se requieren correcciones en el escrito: ${conceptoLimpio}`]);
            }
            else if (nuevo_estado === 'realizada' && finalEstado === 'en_revision') {

                const duenoCartera = abogado_asignado || asignado_a || username;

                // 1. Notificar a los Encargados (Titulares, Socios)
                const encargadosRes = await client.query(`
                    SELECT a.usuario_invitado as username_destino, u.email, u.nombre_real 
                    FROM accesos_cartera a
                    JOIN usuarios_sistema u ON a.usuario_invitado = u.username
                    WHERE a.propietario_cartera = $1 AND a.rol_en_cartera = 'encargado'
                `, [duenoCartera]);

                let destinatarios = encargadosRes.rows;

                // 2. Si el que tachó la tarea (ej. Pasante) NO es el dueño de la cartera (ej. Asociado)
                // Agregamos al Asociado a la lista de correos para que revise a su pasante.
                if (username !== duenoCartera) {
                    const dueñoRes = await client.query(`SELECT username as username_destino, email, nombre_real FROM usuarios_sistema WHERE username = $1`, [duenoCartera]);
                    if (dueñoRes.rows.length > 0) {
                        destinatarios.push(dueñoRes.rows[0]);
                    }
                }

                // Filtramos duplicados por si acaso el dueño también es "encargado"
                const uniqueDestinatarios = [];
                const mapDest = new Set();
                for (const d of destinatarios) {
                    if (!mapDest.has(d.username_destino)) {
                        mapDest.add(d.username_destino);
                        uniqueDestinatarios.push(d);
                    }
                }

                if (uniqueDestinatarios.length > 0) {
                    const transporter = nodemailer.createTransport({ host: 'smtp-relay.brevo.com', port: 587, secure: false, auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
                    const sender = process.env.EMAIL_SENDER || process.env.EMAIL_USER;

                    for (const encargado of uniqueDestinatarios) {
                        // Enviar alerta a la campanita
                        await client.query(`INSERT INTO notificaciones (username_destino, titulo, mensaje, tipo) VALUES ($1, '⏳ Escrito para Revisión', $2, 'info')`, [encargado.username_destino, `${username} ha enviado un escrito para tu revisión: ${conceptoLimpio}`]);

                        // Enviar Correo Elegante
                        if (encargado.email) {
                            const htmlCorreo = `
                            <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border-radius: 8px; overflow: hidden; border-top: 6px solid #e65100; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
                                <div style="padding: 40px 30px; text-align: center; background: white;">
                                    <img src="https://www.vigilex.mx/logo-vigilex.png" alt="VIGILEX" style="max-width: 220px; height: auto; object-fit: contain; display: block; margin: 0 auto 25px auto;">
                                    <h2 style="color: #0a2540; margin-top: 0; font-family: 'Georgia', serif; font-size: 22px;">MESA DE REVISIÓN</h2>
                                    <p style="font-size: 15px; color: #555; text-align: left; margin-top: 20px;">Estimado/a <b>${encargado.nombre_real || encargado.username_destino}</b>,<br><br>El usuario operativo <b>${username}</b> ha concluido la redacción de un escrito en la cartera de asuntos, y requiere su revisión y visto bueno.</p>
                                    
                                    <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #fffde7; border: 1px solid #ffeeba; border-radius: 6px; border-left: 4px solid #e65100; text-align: left; margin: 25px 0;">
                                        <tr>
                                            <td style="padding: 20px;">
                                                <p style="margin: 0 0 8px 0; font-size: 12px; color: #e65100; font-weight: bold; text-transform: uppercase;">Expediente de Referencia:</p>
                                                <p style="margin: 0 0 15px 0; font-size: 15px; color: #333; font-weight: bold;">${numExp}</p>
                                                <p style="margin: 0 0 8px 0; font-size: 12px; color: #e65100; font-weight: bold; text-transform: uppercase;">Concepto del Escrito:</p>
                                                <p style="margin: 0; font-size: 14px; color: #444;">${conceptoLimpio}</p>
                                            </td>
                                        </tr>
                                    </table>
                                    
                                    <div style="margin-top: 35px;">
                                        <a href="https://www.vigilex.mx/expedientes.html" style="display: inline-block; background-color: #e65100; color: white; text-decoration: none; padding: 14px 35px; border-radius: 4px; font-weight: bold; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">Revisar Escrito Ahora</a>
                                    </div>
                                </div>
                                <div style="background-color: #f9f9f9; padding: 20px; text-align: center; border-top: 1px solid #eeeeee;">
                                    <p style="margin: 0; color: #999999; font-size: 11px;">Notificación automática del Sistema Central VIGILEX.</p>
                                </div>
                            </div>`;

                            await transporter.sendMail({
                                from: `"VIGILEX Revisiones" <${sender}>`,
                                to: encargado.email,
                                subject: `⏳ Solicitud de Revisión: ${conceptoLimpio}`,
                                html: htmlCorreo
                            }).catch(e => console.error("Error correo revisión:", e));
                        }
                    }
                }
            }
        } catch (e) { console.error("Error notificaciones:", e); }

        await client.end();
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error) {
        if (client) { try { await client.query('ROLLBACK'); await client.end(); } catch (e) { } }
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};