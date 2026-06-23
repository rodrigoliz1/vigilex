const { Client } = require('pg');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');

// DICCIONARIO DE JERARQUÍAS (Menor número = Más poder)
const RANGOS = { 'master': 10, 'titular': 20, 'socio': 30, 'admin': 40, 'abogado': 40, 'asociado': 50, 'pasante': 60 };

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    let client;
    try {
        // Extraemos la variable "vistaRequerida" enviada desde el frontend
        const { usuarioActual, accion, payload, vistaRequerida } = JSON.parse(event.body);
        client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });

        const authHeader = event.headers.authorization || event.headers.Authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) return { statusCode: 401, body: JSON.stringify({ error: 'Acceso denegado.' }) };
        try { jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); } catch (err) { return { statusCode: 401, body: JSON.stringify({ error: 'Token expirado.' }) }; }

        await client.connect();

        const myUser = await client.query('SELECT id_firma, rol_equipo, nombre_firma FROM usuarios_sistema WHERE username = $1', [usuarioActual]);
        if (myUser.rows.length === 0 || !myUser.rows[0].id_firma) { await client.end(); return { statusCode: 403, body: JSON.stringify({ error: 'No vinculado a firma.' }) }; }

        const idFirma = parseInt(myUser.rows[0].id_firma);
        const miRol = myUser.rows[0].rol_equipo || 'titular';
        const miRango = RANGOS[miRol] || 99;
        const nombreDespacho = myUser.rows[0].nombre_firma;

        // ==========================================
        // ACCIÓN: LISTAR EQUIPO (DOBLE MOTOR)
        // ==========================================
        if (accion === 'listar_equipo') {
            const limiteRes = await client.query('SELECT limite_usuarios FROM firmas WHERE id_firma = $1', [idFirma]);
            const limiteReal = limiteRes.rows.length > 0 ? limiteRes.rows[0].limite_usuarios : 1;

            // Extraemos las carteras a las que el usuario ha sido explícitamente invitado
            const resAccesos = await client.query('SELECT propietario_cartera FROM accesos_cartera WHERE usuario_invitado = $1', [usuarioActual]);
            const carterasPermitidas = resAccesos.rows.map(r => r.propietario_cartera);

            let equipoCrudo = [];

            if (vistaRequerida === 'despacho') {
                // MOTOR 1: VISTA PANORÁMICA (Para el Hub de Expedientes y pestaña "Todo el Despacho")
                const res = await client.query(`SELECT username, email, rol_equipo, fecha_registro, requiere_cambio_pass, nombre_real FROM usuarios_sistema WHERE id_firma = $1`, [idFirma]);
                equipoCrudo = res.rows;
            } else {
                // MOTOR 2: AISLAMIENTO DE CÉLULA (Para la pestaña "Mi Equipo")
                let usernamesCelula = [usuarioActual];

                if (miRol === 'asociado') {
                    // El asociado ve a quienes invitó a su cartera (sus encargados y pasantes)
                    const resInvitados = await client.query('SELECT usuario_invitado FROM accesos_cartera WHERE propietario_cartera = $1', [usuarioActual]);
                    usernamesCelula = usernamesCelula.concat(resInvitados.rows.map(r => r.usuario_invitado));
                }
                else if (miRol === 'pasante') {
                    // El pasante ve a su dueño y a los colegas de esa misma cartera
                    const resDueño = await client.query('SELECT propietario_cartera FROM accesos_cartera WHERE usuario_invitado = $1', [usuarioActual]);
                    if (resDueño.rows.length > 0) {
                        const dueño = resDueño.rows[0].propietario_cartera;
                        usernamesCelula.push(dueño);
                        const resOtros = await client.query('SELECT usuario_invitado FROM accesos_cartera WHERE propietario_cartera = $1', [dueño]);
                        usernamesCelula = usernamesCelula.concat(resOtros.rows.map(r => r.usuario_invitado));
                    }
                }
                else {
                    // Los Jefes en vista "Célula" ven las carteras a las que se unieron
                    usernamesCelula = usernamesCelula.concat(carterasPermitidas);
                    for (const d of carterasPermitidas) {
                        const resColegas = await client.query('SELECT usuario_invitado FROM accesos_cartera WHERE propietario_cartera = $1', [d]);
                        usernamesCelula = usernamesCelula.concat(resColegas.rows.map(r => r.usuario_invitado));
                    }
                }

                // Limpiamos duplicados y extraemos los datos
                const unicos = [...new Set(usernamesCelula)];
                if (unicos.length > 0) {
                    const res = await client.query(`SELECT username, email, rol_equipo, fecha_registro, requiere_cambio_pass, nombre_real FROM usuarios_sistema WHERE id_firma = $1 AND username = ANY($2::text[])`, [idFirma, unicos]);
                    equipoCrudo = res.rows;
                }

                // FILTRO ESTRICTO: Un asociado NUNCA ve a otro asociado en su célula
                if (miRol === 'asociado') {
                    equipoCrudo = equipoCrudo.filter(u => u.username === usuarioActual || u.rol_equipo !== 'asociado');
                }
            }

            // Ordenamos por Jerarquía (Menor RangoNum primero)
            const equipoOrdenado = equipoCrudo.sort((a, b) => (RANGOS[a.rol_equipo] || 99) - (RANGOS[b.rol_equipo] || 99));
            // Inyectamos los rangos numéricos
            const equipoConRango = equipoOrdenado.map(u => ({ ...u, rango_num: (RANGOS[u.rol_equipo] || 99) }));

            await client.end();
            return {
                statusCode: 200,
                body: JSON.stringify({
                    success: true,
                    equipo: equipoConRango,
                    miRol: miRol,
                    miRango: miRango,
                    limite: limiteReal,
                    carteras_permitidas: carterasPermitidas
                })
            };
        }

        // ==========================================
        // ACCIÓN: INVITAR MIEMBRO
        // ==========================================
        else if (accion === 'invitar_miembro') {
            const { nuevoNombre, nuevoUser, nuevoEmail, nuevoPass, nuevoRol } = payload;
            const nuevoRango = RANGOS[nuevoRol] || 99;

            // REGLA EN CASCADA: Solo puedes invitar a alguien de menor jerarquía
            if (nuevoRango <= miRango) {
                await client.end(); return { statusCode: 403, body: JSON.stringify({ error: 'No tienes jerarquía suficiente para crear este rol.' }) };
            }

            const countRes = await client.query('SELECT COUNT(*) FROM usuarios_sistema WHERE id_firma = $1', [idFirma]);
            let limite = (miRol === 'master') ? 999999 : (await client.query('SELECT limite_usuarios FROM firmas WHERE id_firma = $1', [idFirma])).rows[0]?.limite_usuarios || 5;

            if (parseInt(countRes.rows[0].count) >= limite) { await client.end(); return { statusCode: 400, body: JSON.stringify({ error: 'Límite alcanzado.' }) }; }

            const checkDisp = await client.query('SELECT username FROM usuarios_sistema WHERE username = $1 OR email = $2', [nuevoUser, nuevoEmail]);
            if (checkDisp.rows.length > 0) { await client.end(); return { statusCode: 400, body: JSON.stringify({ error: 'Usuario o correo ya existen.' }) }; }

            const codigoOTP = Math.floor(100000 + Math.random() * 900000).toString();
            await client.query(`INSERT INTO usuarios_sistema (nombre_firma, username, email, password_hash, id_firma, rol_equipo, correo_confirmado, requiere_cambio_pass, codigo_verificacion, nombre_real) VALUES ($1, $2, $3, $4, $5, $6, FALSE, TRUE, $7, $8)`, [nombreDespacho, nuevoUser.trim(), nuevoEmail.trim(), nuevoPass, idFirma, nuevoRol, codigoOTP, nuevoNombre.trim()]);

            // Si un Asociado invita a un Pasante, lo vinculamos automáticamente a su cartera
            if (miRol === 'asociado' && nuevoRol === 'pasante') {
                await client.query(`INSERT INTO accesos_cartera (propietario_cartera, usuario_invitado, rol_en_cartera) VALUES ($1, $2, 'colaborador')`, [usuarioActual, nuevoUser.trim()]);
            }
            await client.end();

            // Correo Electrónico (Silencioso en caso de fallo)
            try {
                const transporter = nodemailer.createTransport({ host: 'smtp-relay.brevo.com', port: 587, secure: false, auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
                const sender = process.env.EMAIL_SENDER || process.env.EMAIL_USER;
                const htmlEmail = `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 12px; overflow: hidden;"><div style="background-color: #0a2540; padding: 30px; text-align: center;"><img src="https://www.vigilex.mx/logo-vigilex.png" style="width: 160px;"></div><div style="padding: 40px; background-color: #ffffff;"><h2 style="color: #0a2540; text-align: center;">¡Bienvenido a la firma digital!</h2><p style="text-align: center;">Hola <strong>${nuevoNombre.trim()}</strong>, se ha creado tu cuenta corporativa.</p><div style="background-color: #f4f6f8; border-left: 5px solid #ad974f; padding: 20px; margin: 30px 0;"><p><strong>Usuario:</strong> ${nuevoUser.trim()}</p><p><strong>Contraseña:</strong> ${nuevoPass}</p><p><strong>OTP de Validación:</strong> <b style="font-size:18px;">${codigoOTP}</b></p></div><div style="text-align: center;"><a href="https://www.vigilex.mx/inicio.html" style="background-color: #ad974f; color: #ffffff; padding: 15px 30px; text-decoration: none; border-radius: 6px; font-weight: bold;">ACCEDER AL SISTEMA</a></div></div></div>`;
                await transporter.sendMail({ from: `"VIGILEX Notificaciones" <${sender}>`, to: nuevoEmail.trim(), subject: `🔑 Accesos Corporativos - ${nombreDespacho}`, html: htmlEmail });
            } catch (e) { }

            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // ==========================================
        // ACCIÓN: REVOCAR USUARIO
        // ==========================================
        else if (accion === 'revocar_usuario') {
            const { targetUsername } = payload;
            if (targetUsername === usuarioActual) { await client.end(); return { statusCode: 400, body: JSON.stringify({ error: 'No puedes revocarte a ti mismo.' }) }; }

            const targetData = await client.query('SELECT rol_equipo FROM usuarios_sistema WHERE username=$1', [targetUsername]);
            const targetRango = RANGOS[targetData.rows[0]?.rol_equipo] || 0;

            if (targetRango <= miRango) {
                await client.end(); return { statusCode: 403, body: JSON.stringify({ error: 'Tu jerarquía no te permite revocar a este usuario.' }) };
            }

            await client.query('UPDATE expedientes SET abogado_asignado = $1 WHERE abogado_asignado = $2 AND id_firma = $3', [usuarioActual, targetUsername, idFirma]);
            await client.query(`UPDATE tareas_expediente SET asignado_a = $1 WHERE asignado_a = $2 AND estado = 'pendiente' AND id_expediente IN (SELECT id_expediente FROM expedientes WHERE id_firma = $3)`, [usuarioActual, targetUsername, idFirma]);
            await client.query('DELETE FROM usuarios_sistema WHERE username = $1 AND id_firma = $2', [targetUsername, idFirma]);
            await client.query('DELETE FROM accesos_cartera WHERE propietario_cartera = $1 OR usuario_invitado = $1', [targetUsername]);

            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true, mensaje: 'Usuario revocado y expedientes transferidos a tu control.' }) };
        }

        // ==========================================
        // ACCIÓN: CAMBIAR CARGO
        // ==========================================
        else if (accion === 'cambiar_rol') {
            const { targetUsername, nuevoRol } = payload;
            const nuevoRango = RANGOS[nuevoRol] || 99;

            const targetRes = await client.query('SELECT rol_equipo FROM usuarios_sistema WHERE username = $1', [targetUsername]);
            if (targetRes.rows.length === 0) { await client.end(); return { statusCode: 404, body: JSON.stringify({ error: 'Usuario no encontrado.' }) }; }

            const targetRangoActual = RANGOS[targetRes.rows[0].rol_equipo] || 99;

            // Protecciones Jerárquicas
            if (miRango >= targetRangoActual) { await client.end(); return { statusCode: 403, body: JSON.stringify({ error: 'No tienes jerarquía para modificar a este usuario.' }) }; }
            if (miRango >= nuevoRango) { await client.end(); return { statusCode: 403, body: JSON.stringify({ error: 'No puedes asignar un rango igual o superior al tuyo.' }) }; }

            await client.query('UPDATE usuarios_sistema SET rol_equipo = $1 WHERE username = $2', [nuevoRol, targetUsername]);
            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true, mensaje: 'Cargo actualizado correctamente.' }) };
        }

        await client.end();
        return { statusCode: 400, body: JSON.stringify({ error: 'Acción no válida.' }) };

    } catch (error) {
        if (client) await client.end();
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};