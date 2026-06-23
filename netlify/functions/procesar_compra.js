const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Client } = require('pg');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    try {
        const { session_id } = JSON.parse(event.body);
        const client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });
        await client.connect();

        const checkRes = await client.query('SELECT codigo, dias_vigencia, email_comprador FROM licencias WHERE stripe_session_id = $1', [session_id]);
        if (checkRes.rows.length > 0) { await client.end(); return { statusCode: 200, body: JSON.stringify({ success: true, codigo: checkRes.rows[0].codigo, dias: checkRes.rows[0].dias_vigencia, email: checkRes.rows[0].email_comprador }) }; }

        const session = await stripe.checkout.sessions.retrieve(session_id, { expand: ['line_items', 'subscription'] });

        const emailCliente = session.customer_details.email;
        const productName = session.line_items.data[0].description.toLowerCase();

        let categoria = "Institucional Profesional";
        if (productName.includes('personal')) categoria = "Personal";
        else if (productName.includes('starter')) categoria = "Institucional Starter";

        let dias = 30; let frecuenciaFacturacion = "mes";
        if (productName.includes('14')) { dias = 14; frecuenciaFacturacion = "N/A"; }
        else if (productName.includes('6 mes') || productName.includes('semestral')) { dias = 180; frecuenciaFacturacion = "6 meses"; }
        else if (productName.includes('anual') || productName.includes('año')) { dias = 365; frecuenciaFacturacion = "año"; }

        let planNombre = `Plan ${categoria}`;

        let stripe_sub_id = null; let en_prueba = false; let trial_days = null; let trial_end = null;
        let fechaCobroTexto = ""; let fechaCancelacionTexto = ""; let infoPruebaHtml = "";

        if (session.mode === 'subscription' && session.subscription) {
            stripe_sub_id = session.subscription.id;
            if (session.subscription.trial_end) {
                en_prueba = true;
                const dateEnd = new Date(session.subscription.trial_end * 1000);
                trial_end = dateEnd.toISOString();
                trial_days = Math.ceil((dateEnd - new Date()) / (1000 * 60 * 60 * 24));

                const opcionesFecha = { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Mexico_City' };
                fechaCobroTexto = dateEnd.toLocaleDateString('es-MX', opcionesFecha);

                const dateCancelacionLimite = new Date(dateEnd);
                dateCancelacionLimite.setDate(dateCancelacionLimite.getDate() - 1);
                fechaCancelacionTexto = dateCancelacionLimite.toLocaleDateString('es-MX', opcionesFecha);

                infoPruebaHtml = `
                    <div style="background-color: #fcf8e3; border: 1px solid #fbc02d; padding: 20px; margin: 20px 0; border-radius: 8px; text-align: left;">
                        <p style="margin: 0 0 10px 0; font-size: 15px; color: #856404; font-weight: bold;">🎁 Disfruta de tus ${trial_days} días gratis</p>
                        <p style="margin: 0 0 10px 0; font-size: 14px; color: #555; line-height: 1.5;">
                            Tu suscripción se facturará cada <strong>${frecuenciaFacturacion}</strong>. Tu primer pago se realizará de manera automática el día <strong>${fechaCobroTexto}</strong>.
                        </p>
                        <p style="margin: 0; font-size: 13px; color: #666; font-style: italic;">
                            Podrás cancelar tu suscripción sin ningún cargo dentro de tu periodo de prueba gratuita, tienes hasta el <strong>${fechaCancelacionTexto}</strong> para hacerlo desde tu Panel de Control.
                        </p>
                    </div>
                `;
            }
        }

        const randomString = crypto.randomBytes(4).toString('hex').toUpperCase();
        const nuevoCodigo = `VIG-${randomString.slice(0, 4)}-${randomString.slice(4, 8)}`;

        const insertQuery = `
            INSERT INTO licencias (codigo, dias_vigencia, stripe_session_id, email_comprador, stripe_subscription_id, plan_nombre, en_prueba, trial_days, trial_end) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `;
        await client.query(insertQuery, [nuevoCodigo, dias, session_id, emailCliente, stripe_sub_id, planNombre, en_prueba, trial_days, trial_end]);
        await client.end();

        // Enviar Correo Electrónico Premium CON BREVO
        const transporter = nodemailer.createTransport({
            host: 'smtp-relay.brevo.com', port: 587, secure: false,
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });
        const sender = process.env.EMAIL_SENDER || process.env.EMAIL_USER;

        const htmlEmail = `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
            <div style="background-color: #0a2540; padding: 30px; text-align: center;">
                <img src="https://www.vigilex.mx/logo-vigilex.png" alt="VIGILEX" style="width: 160px;">
            </div>
            <div style="padding: 40px; background-color: #ffffff;">
                <h2 style="color: #0a2540; margin-top: 0; text-align: center;">¡Gracias por tu compra!</h2>
                <p style="font-size: 16px; line-height: 1.6; text-align: center;">
                    Has adquirido una licencia para el <strong>${planNombre}</strong> del Sistema Integral VIGILEX.
                </p>

                ${infoPruebaHtml}

                <div style="background-color: #f4fbfd; border-left: 5px solid #0277bd; padding: 20px; margin: 30px 0; text-align: center; border-radius: 0 8px 8px 0;">
                    <p style="margin: 0 0 10px 0; font-size: 12px; color: #0277bd; text-transform: uppercase; font-weight: bold;">CÓDIGO DE ACTIVACIÓN OFICIAL</p>
                    <p style="margin: 0; font-size: 28px; font-weight: bold; letter-spacing: 4px; color: #0a2540;">${nuevoCodigo}</p>
                </div>

                <div style="text-align: center; margin: 40px 0;">
                    <a href="https://www.vigilex.mx/inicio.html" style="background-color: #ad974f; color: #ffffff; padding: 15px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px; display: inline-block;">IR A REGISTRAR LICENCIA</a>
                </div>

                <p style="font-size: 13px; color: #666; text-align: center;">
                    Copia el código superior y presiona el botón <strong>"Registrar Licencia"</strong> en la pantalla de inicio de sesión para activar tu despacho.
                </p>
            </div>
            <div style="background-color: #f8f9fa; padding: 20px; text-align: center; border-top: 1px solid #eee;">
                <p style="margin: 0; font-size: 12px; color: #999;">VIGILEX | Gestión Jurisdiccional Inteligente<br>Este es un recibo automático, por favor no respondas.</p>
            </div>
        </div>`;

        await transporter.sendMail({
            from: `"VIGILEX Ventas" <${sender}>`,
            to: emailCliente,
            subject: '✅ Tu Licencia de VIGILEX está lista',
            html: htmlEmail
        });

        return { statusCode: 200, body: JSON.stringify({ success: true, codigo: nuevoCodigo, email: emailCliente }) };
    } catch (error) { return { statusCode: 500, body: JSON.stringify({ error: 'Error procesando la licencia' }) }; }
};