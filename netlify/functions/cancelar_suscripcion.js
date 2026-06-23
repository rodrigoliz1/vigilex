const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Client } = require('pg');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    try {
        const { username, password } = JSON.parse(event.body);
        if (!password) return { statusCode: 400, body: JSON.stringify({ error: 'Contraseña requerida.' }) };

        const client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });

        // --- BARRERA JWT ---
        const authHeader = event.headers.authorization || event.headers.Authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) return { statusCode: 401, body: JSON.stringify({ error: 'Token no proporcionado.' }) };
        try { jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); }
        catch (err) { return { statusCode: 401, body: JSON.stringify({ error: 'Token inválido o expirado.' }) }; }

        await client.connect();

        // 1. VALIDAR CONTRASEÑA CON BCRYPT
        const authCheck = await client.query(`
            SELECT u.password_hash, u.email, u.nombre_real, f.stripe_subscription_id, f.id_firma, f.en_prueba, f.trial_end, f.fecha_expiracion 
            FROM usuarios_sistema u 
            JOIN firmas f ON u.id_firma = f.id_firma 
            WHERE u.username = $1`, [username]
        );

        if (authCheck.rows.length === 0) { await client.end(); return { statusCode: 401, body: JSON.stringify({ error: 'Usuario no encontrado.' }) }; }

        const user = authCheck.rows[0];
        const validPass = await bcrypt.compare(password, user.password_hash);
        if (!validPass) { await client.end(); return { statusCode: 401, body: JSON.stringify({ error: 'Contraseña incorrecta.' }) }; }

        const subId = user.stripe_subscription_id;
        if (!subId) { await client.end(); return { statusCode: 400, body: JSON.stringify({ error: "No hay suscripción activa para cancelar." }) }; }

        // 2. CANCELACIÓN EN STRIPE
        await stripe.subscriptions.update(subId, { cancel_at_period_end: true });

        // 3. ACTUALIZAR DB
        await client.query('UPDATE firmas SET suscripcion_cancelada = true WHERE id_firma = $1', [user.id_firma]);
        await client.query('UPDATE usuarios_sistema SET suscripcion_cancelada = true WHERE id_firma = $1', [user.id_firma]);
        await client.end();

        // 4. FECHA DE CORTE PARA EL CORREO
        let fechaFinReal = (user.en_prueba && user.trial_end) ? new Date(user.trial_end) : new Date(user.fecha_expiracion);
        fechaFinReal.setMinutes(fechaFinReal.getMinutes() + fechaFinReal.getTimezoneOffset());
        const fechaFmt = fechaFinReal.toLocaleDateString('es-MX', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

        // 5. CORREO PREMIUM CON BREVO
        if (user.email) {
            const transporter = nodemailer.createTransport({ host: 'smtp-relay.brevo.com', port: 587, secure: false, auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
            const sender = process.env.EMAIL_SENDER || process.env.EMAIL_USER;

            await transporter.sendMail({
                from: `"VIGILEX Facturación" <${sender}>`, to: user.email, subject: '🛑 Suscripción Cancelada - VIGILEX',
                html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
                    <div style="background-color: #0a2540; padding: 25px; text-align: center; border-bottom: 4px solid #c62828;">
                        <img src="https://www.vigilex.mx/logo-vigilex.png" alt="VIGILEX" style="width: 150px;">
                    </div>
                    <div style="padding: 35px; background-color: #ffffff;">
                        <h2 style="color: #c62828; margin-top: 0; text-align: center;">Suscripción Cancelada</h2>
                        <p style="font-size: 15px;">Hola <strong>${user.nombre_real || username}</strong>, hemos procesado tu solicitud.</p>
                        <p style="font-size: 15px;">Tu suscripción ha sido cancelada en el sistema bancario y <strong>NO se realizarán más cargos automáticos</strong> a tu método de pago.</p>
                        
                        <div style="background-color: #ffebee; border-left: 4px solid #c62828; padding: 15px; margin: 25px 0;">
                            <span style="font-size:12px; color:#555; text-transform:uppercase;">TU ACCESO PREMIUM FINALIZARÁ EL DÍA:</span><br>
                            <strong style="font-size: 18px; color: #c62828;">${fechaFmt.toUpperCase()}</strong>
                        </div>
                        
                        <p style="font-size: 13px; color: #666;">Podrás seguir utilizando todas las herramientas de Vigilex hasta esa fecha. Si cambias de opinión, puedes reactivarla fácilmente en tu portal de Suscripción.</p>
                    </div>
                </div>`
            });
        }

        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error) { return { statusCode: 500, body: JSON.stringify({ error: error.message }) }; }
};