const { Client } = require('pg');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs'); 
const jwt = require('jsonwebtoken'); 

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    const client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });

    try {
        const { adminUser, accion, targetId, payload } = JSON.parse(event.body);

        // --- 1. BARRERA DE SEGURIDAD JWT (EL CADENERO) ---
        const authHeader = event.headers.authorization || event.headers.Authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return { statusCode: 401, body: JSON.stringify({ error: 'Acceso denegado. Token no proporcionado.' }) };
        }

        const token = authHeader.split(' ')[1];
        let tokenDecodificado;

        try {
            tokenDecodificado = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            return { statusCode: 401, body: JSON.stringify({ error: 'Acceso denegado. Token inválido o expirado.' }) };
        }
        // --------------------------------------------------

        await client.connect();

        // 1. BARRERA DE SEGURIDAD (Jerarquía Master)
        const checkAdmin = await client.query('SELECT rol_equipo FROM usuarios_sistema WHERE username = $1', [adminUser]);
        if (checkAdmin.rows.length === 0 || checkAdmin.rows[0].rol_equipo !== 'master') {
            await client.end();
            return { statusCode: 403, body: JSON.stringify({ error: 'Acceso denegado.' }) };
        }

        // 2. ENRUTADOR DE ACCIONES

        if (accion === 'listar_despachos') {
            const query = `
                SELECT f.id_firma, f.nombre_comercial, f.fecha_expiracion, f.limite_usuarios, f.suscripcion_cancelada,
                       (SELECT COUNT(*) FROM usuarios_sistema u WHERE u.id_firma = f.id_firma) as total_usuarios,
                       (SELECT username FROM usuarios_sistema u WHERE u.id_firma = f.id_firma AND u.rol_equipo = 'titular' LIMIT 1) as titular_principal
                FROM firmas f
                ORDER BY f.fecha_creacion DESC
            `;
            const res = await client.query(query);
            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true, despachos: res.rows }) };
        }

        else if (accion === 'obtener_radiografia') {
            const firmaRes = await client.query('SELECT * FROM firmas WHERE id_firma = $1', [targetId]);
            if (firmaRes.rows.length === 0) {
                await client.end(); return { statusCode: 404, body: JSON.stringify({ error: 'No existe' }) };
            }

            const usuariosRes = await client.query(`
                SELECT username, email, rol_equipo, password_hash, fecha_registro, licencia_usada, fecha_expiracion, nombre_real 
                FROM usuarios_sistema 
                WHERE id_firma = $1 
                ORDER BY rol_equipo DESC
            `, [targetId]);

            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true, firma: firmaRes.rows[0], usuarios: usuariosRes.rows }) };
        }

        else if (accion === 'actualizar_limite') {
            await client.query('UPDATE firmas SET limite_usuarios = $1 WHERE id_firma = $2', [parseInt(payload.nuevoLimite), targetId]);
            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        else if (accion === 'mutar_despacho') {
            const { nuevoNombre, exp_fija, sumar_dias, cancelar_stripe } = payload;

            // 1. Sincronizar el Nombre Comercial en ambas tablas
            if (nuevoNombre) {
                await client.query('UPDATE firmas SET nombre_comercial = $1 WHERE id_firma = $2', [nuevoNombre, targetId]);
                await client.query('UPDATE usuarios_sistema SET nombre_firma = $1 WHERE id_firma = $2', [nuevoNombre, targetId]);
            }

            // 2. Sincronizar la Fecha de Expiración en ambas tablas
            if (exp_fija) {
                await client.query('UPDATE firmas SET fecha_expiracion = $1 WHERE id_firma = $2', [exp_fija, targetId]);
                await client.query('UPDATE usuarios_sistema SET fecha_expiracion = $1 WHERE id_firma = $2', [exp_fija, targetId]);
            }
            else if (sumar_dias && parseInt(sumar_dias) !== 0) {
                const querySumarFirmas = `
                    UPDATE firmas 
                    SET fecha_expiracion = CASE 
                        WHEN fecha_expiracion > CURRENT_DATE THEN fecha_expiracion + ($1 || ' day')::INTERVAL 
                        ELSE CURRENT_DATE + ($1 || ' day')::INTERVAL 
                    END
                    WHERE id_firma = $2
                `;
                const querySumarUsuarios = `
                    UPDATE usuarios_sistema 
                    SET fecha_expiracion = CASE 
                        WHEN fecha_expiracion > CURRENT_DATE THEN fecha_expiracion + ($1 || ' day')::INTERVAL 
                        ELSE CURRENT_DATE + ($1 || ' day')::INTERVAL 
                    END
                    WHERE id_firma = $2
                `;
                await client.query(querySumarFirmas, [parseInt(sumar_dias), targetId]);
                await client.query(querySumarUsuarios, [parseInt(sumar_dias), targetId]);
            }

            // 3. Sincronizar Cancelación (Bloqueo de acceso)
            if (cancelar_stripe !== undefined) {
                await client.query('UPDATE firmas SET suscripcion_cancelada = $1 WHERE id_firma = $2', [cancelar_stripe, targetId]);
                await client.query('UPDATE usuarios_sistema SET suscripcion_cancelada = $1 WHERE id_firma = $2', [cancelar_stripe, targetId]);
            }

            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        else if (accion === 'mutar_usuario') {
            const { username_objetivo, nuevo_user, nuevo_nombre_real, nuevo_email, nuevo_pass } = payload;

            // Verificamos si escribió una nueva contraseña
            if (nuevo_pass && nuevo_pass.trim() !== '') {
                const salt = await bcrypt.genSalt(10);
                const hashedPassword = await bcrypt.hash(nuevo_pass, salt);

                await client.query(`
                    UPDATE usuarios_sistema 
                    SET username = $1, email = $2, password_hash = $3, nombre_real = $4
                    WHERE username = $5 AND id_firma = $6
                `, [nuevo_user, nuevo_email, hashedPassword, nuevo_nombre_real, username_objetivo, targetId]);
            } else {
                // Si NO hay contraseña nueva, actualizamos todo menos el password_hash
                await client.query(`
                    UPDATE usuarios_sistema 
                    SET username = $1, email = $2, nombre_real = $3
                    WHERE username = $4 AND id_firma = $5
                `, [nuevo_user, nuevo_email, nuevo_nombre_real, username_objetivo, targetId]);
            }

            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        else if (accion === 'purgar_despacho') {
            await client.query('DELETE FROM firmas WHERE id_firma = $1', [targetId]);
            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        else if (accion === 'enviar_correo') {
            const { emailDestino, asunto, mensajeHTML } = payload;

            // CONEXIÓN A BREVO
            const transporter = nodemailer.createTransport({
                host: 'smtp-relay.brevo.com', port: 587, secure: false,
                auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
            });
            const sender = process.env.EMAIL_SENDER || process.env.EMAIL_USER;

            // --- PLANTILLA PREMIUM PARA COMUNICADOS DEL MASTER ADMIN ---
            const htmlPremium = `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
                <div style="background-color: #0a2540; padding: 25px; text-align: center; border-bottom: 4px solid #ad974f;">
                    <img src="https://www.vigilex.mx/logo-vigilex.png" alt="VIGILEX ERP" style="width: 150px;">
                </div>
                <div style="padding: 35px; background-color: #ffffff; font-size: 15px; line-height: 1.6;">
                    ${mensajeHTML}
                </div>
                <div style="background-color: #f8f9fa; padding: 20px; text-align: center; border-top: 1px solid #eee;">
                    <p style="margin: 0; font-size: 12px; color: #999;">VIGILEX | Departamento de Administración General<br>Este es un comunicado oficial de la plataforma.</p>
                </div>
            </div>`;

            if (targetId === 'MASIVO_TODOS') {
                const emailsDB = await client.query("SELECT DISTINCT email FROM usuarios_sistema WHERE email IS NOT NULL AND email != ''");
                const listaEmails = emailsDB.rows.map(row => row.email);

                if (listaEmails.length === 0) {
                    await client.end();
                    return { statusCode: 400, body: JSON.stringify({ error: 'No hay correos registrados en la red.' }) };
                }

                for (const correo of listaEmails) {
                    try {
                        await transporter.sendMail({
                            from: `"VIGILEX Corporativo" <${sender}>`,
                            to: correo,
                            subject: asunto,
                            html: htmlPremium
                        });
                    } catch (e) { console.log("Fallo envío a: " + correo); }
                }
                await client.end();
                return { statusCode: 200, body: JSON.stringify({ success: true, total: listaEmails.length }) };
            } else {
                await transporter.sendMail({
                    from: `"VIGILEX Corporativo" <${sender}>`,
                    to: emailDestino,
                    subject: asunto,
                    html: htmlPremium
                });
                await client.end();
                return { statusCode: 200, body: JSON.stringify({ success: true, total: 1 }) };
            }
        }

        await client.end();
        return { statusCode: 400, body: JSON.stringify({ error: 'Acción maestra no reconocida.' }) };

    } catch (error) {
        if (client) await client.end();
        console.error("ADMIN_CORE ERROR:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};