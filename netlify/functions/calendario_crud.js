const { Client } = require('pg');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    const client = new Client({
        connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED,
        ssl: { rejectUnauthorized: false }
    });

    try {
        const body = JSON.parse(event.body);
        const {
            username, accion, id_evento, titulo, fecha_inicio, fecha_fin,
            todo_el_dia, tipo_calendario, invitados, usernames_invitados, invitar_a_todos
        } = body;

        // --- 1. BARRERA DE SEGURIDAD JWT ---
        const authHeader = event.headers.authorization || event.headers.Authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return { statusCode: 401, body: JSON.stringify({ error: 'Acceso denegado.' }) };
        }

        const token = authHeader.split(' ')[1];
        try {
            jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            return { statusCode: 401, body: JSON.stringify({ error: 'Token inválido o expirado.' }) };
        }

        await client.connect();

        // --- 2. PROCESOS CRUD ---

        if (accion === 'eliminar_por_titulo') {
            await client.query(
                `DELETE FROM eventos_calendario WHERE username = $1 AND titulo_evento = $2`,
                [username, titulo]
            );
            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true, message: 'Limpieza de duplicados realizada' }) };
        }

        else if (accion === 'agregar') {
            const tipoFinal = tipo_calendario || 'personal';
            const res = await client.query(`
                INSERT INTO eventos_calendario (username, titulo_evento, fecha_vencimiento, fecha_termino, todo_el_dia, tipo_calendario, creado_por, invitados) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id_evento
            `, [username, titulo, fecha_inicio, fecha_fin, todo_el_dia, tipoFinal, username, invitados]);
            var idEventoFinal = res.rows[0].id_evento;
        }

        else if (accion === 'editar') {
            await client.query(`
                UPDATE eventos_calendario SET titulo_evento = $1, fecha_vencimiento = $2, fecha_termino = $3, todo_el_dia = $4, invitados = $5 
                WHERE id_evento = $6 AND username = $7
            `, [titulo, fecha_inicio, fecha_fin, todo_el_dia, invitados, id_evento, username]);
        }

        else if (accion === 'eliminar') {
            await client.query(`DELETE FROM eventos_calendario WHERE id_evento = $1 AND username = $2`, [id_evento, username]);
            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // --- 3. PROCESO DE INVITACIONES INTERNAS ---
        if (accion === 'agregar' || accion === 'editar') {
            try {
                let listaDestinatarios = [];
                if (invitar_a_todos) {
                    const usersRes = await client.query('SELECT username FROM usuarios_sistema WHERE id_firma = (SELECT id_firma FROM usuarios_sistema WHERE username = $1)', [username]);
                    listaDestinatarios = usersRes.rows.map(r => r.username).filter(u => u !== username);
                } else if (usernames_invitados && Array.isArray(usernames_invitados)) {
                    listaDestinatarios = usernames_invitados;
                }

                for (const dest of listaDestinatarios) {
                    const check = await client.query(`SELECT id_evento FROM eventos_calendario WHERE username = $1 AND creado_por = $2 AND fecha_vencimiento = $3 AND titulo_evento LIKE $4`, [dest, username, fecha_inicio, `%${titulo}%`]);

                    if (check.rowCount === 0) {
                        await client.query(`
                            INSERT INTO eventos_calendario (username, titulo_evento, fecha_vencimiento, fecha_termino, todo_el_dia, tipo_calendario, creado_por)
                            VALUES ($1, $2, $3, $4, $5, 'personal', $6)
                        `, [dest, `📩 INV: ${titulo}`, fecha_inicio, fecha_fin, todo_el_dia, username]);

                        await client.query(`
                            INSERT INTO notificaciones (username_destino, titulo, mensaje, tipo, url_accion)
                            VALUES ($1, '📅 Invitación de Agenda', $2, 'evento', 'calendario.html?tipo=personal')
                        `, [dest, `${username} te invitó a: ${titulo}`]);
                    }
                }
            } catch (errInv) { console.error("Error en notificaciones internas:", errInv); }

            // --- 4. ENVÍO DE CORREO EXTERNO (NODEMAILER CON BREVO) ---
            if (invitados && invitados.trim() !== '') {
                try {
                    const transporter = nodemailer.createTransport({
                        host: 'smtp-relay.brevo.com', port: 587, secure: false,
                        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
                    });
                    const sender = process.env.EMAIL_SENDER || process.env.EMAIL_USER;

                    const formatICS = (str) => {
                        if (!str) return "";
                        return str.replace(/[-:]/g, '').split('.')[0] + 'Z';
                    };

                    const icsContent = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nDTSTART:${formatICS(fecha_inicio)}\r\nSUMMARY:${titulo}\r\nEND:VEVENT\r\nEND:VCALENDAR`;

                    await transporter.sendMail({
                        from: `"Vigilex Agenda" <${sender}>`,
                        to: invitados,
                        subject: `📅 Invitación: ${titulo}`,
                        html: `<div style="font-family:sans-serif; border-top:4px solid #ad974f; padding:20px;">
                                <h2>Invitación Institucional</h2>
                                <p><b>${username}</b> te ha invitado a un evento.</p>
                                <p><b>Asunto:</b> ${titulo}</p>
                                <p>Fecha: ${fecha_inicio.split('T')[0]}</p>
                               </div>`,
                        icalEvent: { filename: 'invitacion.ics', method: 'request', content: icsContent }
                    });
                } catch (errMail) { console.error("Error correo externo:", errMail); }
            }
        }

        await client.end();
        return { statusCode: 200, body: JSON.stringify({ success: true }) };

    } catch (error) {
        if (client) await client.end();
        console.error("Error crítico:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};