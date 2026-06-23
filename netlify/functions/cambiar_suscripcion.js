const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Client } = require('pg');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    try {
        const { username, password, new_price_id, nuevo_plan } = JSON.parse(event.body);
        if (!password) return { statusCode: 400, body: JSON.stringify({ error: 'Contraseña requerida.' }) };

        const client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });

        const authHeader = event.headers.authorization || event.headers.Authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) return { statusCode: 401, body: JSON.stringify({ error: 'Token no proporcionado.' }) };
        try { jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); }
        catch (err) { return { statusCode: 401, body: JSON.stringify({ error: 'Token inválido o expirado.' }) }; }

        await client.connect();

        const authCheck = await client.query(`
            SELECT u.password_hash, u.email, u.nombre_real, f.stripe_subscription_id, f.id_firma, f.en_prueba, f.trial_end, f.limite_usuarios 
            FROM usuarios_sistema u 
            JOIN firmas f ON u.id_firma = f.id_firma 
            WHERE u.username = $1`, [username]
        );

        if (authCheck.rows.length === 0) { await client.end(); return { statusCode: 401, body: JSON.stringify({ error: 'Usuario no encontrado.' }) }; }

        const user = authCheck.rows[0];
        const limiteAnterior = user.limite_usuarios || 1; 

        const validPass = await bcrypt.compare(password, user.password_hash);
        if (!validPass) { await client.end(); return { statusCode: 401, body: JSON.stringify({ error: 'Contraseña incorrecta.' }) }; }

        const subId = user.stripe_subscription_id;
        if (!subId) { await client.end(); return { statusCode: 400, body: JSON.stringify({ error: "No hay suscripción activa." }) }; }

        const currentSub = await stripe.subscriptions.retrieve(subId);
        let updatePayload = {
            items: [{ id: currentSub.items.data[0].id, price: new_price_id }],
            proration_behavior: 'create_prorations',
            cancel_at_period_end: false
        };

        let nuevosDiasTrial = 7;
        if (nuevo_plan.toLowerCase().includes('semestral')) nuevosDiasTrial = 14;
        else if (nuevo_plan.toLowerCase().includes('anual')) nuevosDiasTrial = 30;

        if (user.en_prueba && user.trial_end) {
            const hoy = new Date();
            const trialEndActual = new Date(user.trial_end);
            const diasRestantesActuales = Math.ceil((trialEndActual - hoy) / (1000 * 60 * 60 * 24));

            if (diasRestantesActuales > 0) {
                const diasAOtorgar = Math.max(diasRestantesActuales, nuevosDiasTrial);
                updatePayload.trial_end = Math.floor((hoy.getTime() + (diasAOtorgar * 24 * 60 * 60 * 1000)) / 1000);
            }
        }

        const updatedSub = await stripe.subscriptions.update(subId, updatePayload);

        let newTrialEndIso = null;
        if (updatedSub.trial_end) newTrialEndIso = new Date(updatedSub.trial_end * 1000).toISOString();

        let limiteNuevo = 99999;
        if (nuevo_plan.toLowerCase().includes('personal')) limiteNuevo = 1;
        else if (nuevo_plan.toLowerCase().includes('starter')) limiteNuevo = 5;

        if (limiteNuevo < limiteAnterior) {
            await client.query(`
                UPDATE firmas SET plan_nombre = $1, suscripcion_cancelada = false, trial_end = $2, limite_usuarios = $4, fecha_downgrade = CURRENT_TIMESTAMP
                WHERE id_firma = $3`, [nuevo_plan, newTrialEndIso, user.id_firma, limiteNuevo]
            );
        } else {
            await client.query(`
                UPDATE firmas SET plan_nombre = $1, suscripcion_cancelada = false, trial_end = $2, limite_usuarios = $4, fecha_downgrade = NULL
                WHERE id_firma = $3`, [nuevo_plan, newTrialEndIso, user.id_firma, limiteNuevo]
            );
        }
        await client.query('UPDATE usuarios_sistema SET suscripcion_cancelada = false WHERE id_firma = $1', [user.id_firma]);
        await client.end();

        // 5. ENVIAR CORREO PREMIUM CON BREVO
        if (user.email) {
            let warningDowngradeHtml = "";
            if (limiteNuevo < limiteAnterior) {
                warningDowngradeHtml = `
                <div style="background-color: #fff3e0; border-left: 4px solid #e65100; padding: 15px; margin: 25px 0; border-radius: 4px;">
                    <span style="font-size:12px; color:#e65100; text-transform:uppercase; font-weight:bold;">⚠️ Aviso de Inhabilitación de Cuentas</span><br>
                    <p style="font-size: 13.5px; color: #555; margin-top: 8px; line-height: 1.5;">
                        Has cambiado a un plan con menor capacidad de usuarios. Las cuentas corporativas que excedan tu nuevo límite de <strong>${limiteNuevo} abogado(s)</strong> han sido inhabilitadas inmediatamente en el Panel de Despacho.<br><br>
                        <strong>Importante:</strong> Si no mejoras tu plan en los próximos, las cuentas inhabilitadas y su historial de expedientes serán eliminados permanentemente de la base de datos en un plazo de <strong>14 días</strong>.
                    </p>
                </div>`;
            }

            const transporter = nodemailer.createTransport({ host: 'smtp-relay.brevo.com', port: 587, secure: false, auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
            const sender = process.env.EMAIL_SENDER || process.env.EMAIL_USER;

            await transporter.sendMail({
                from: `"VIGILEX Facturación" <${sender}>`, to: user.email, subject: '🔄 Cambio de Plan Exitoso - VIGILEX',
                html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
                    <div style="background-color: #0a2540; padding: 25px; text-align: center; border-bottom: 4px solid #0277bd;">
                        <img src="https://www.vigilex.mx/logo-vigilex.png" alt="VIGILEX" style="width: 150px;">
                    </div>
                    <div style="padding: 35px; background-color: #ffffff;">
                        <h2 style="color: #0a2540; margin-top: 0; text-align: center;">Plan Actualizado</h2>
                        <p style="font-size: 15px;">Hola <strong>${user.nombre_real || username}</strong>, tu suscripción ha sido modificada con éxito.</p>
                        
                        <div style="background-color: #f4fbfd; border-left: 4px solid #0277bd; padding: 15px; margin: 20px 0;">
                            <span style="font-size:12px; color:#555; text-transform:uppercase;">NUEVO PLAN ACTIVO:</span><br>
                            <strong style="font-size: 18px; color: #0a2540;">${nuevo_plan}</strong>
                        </div>
                        
                        <p style="font-size: 14px; color: #666;">Los beneficios, límites de usuarios y fechas de facturación se han ajustado automáticamente.</p>
                        
                        ${warningDowngradeHtml}
                        
                        <div style="text-align: center; margin-top: 30px;">
                            <a href="https://www.vigilex.mx/suscripcion.html" style="background: #0277bd; color: #fff; padding: 12px 25px; text-decoration: none; border-radius: 6px; font-weight: bold;">Ver Detalles de Suscripción</a>
                        </div>
                    </div>
                </div>`
            });
        }

        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error) { return { statusCode: 500, body: JSON.stringify({ error: error.message }) }; }
};