const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Client } = require('pg');
const nodemailer = require('nodemailer');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };
    try {
        const stripeEvent = JSON.parse(event.body);
        if (stripeEvent.type === 'checkout.session.completed') {
            const session = stripeEvent.data.object;
            const referenceUsername = session.client_reference_id; // Este es el username del cliente
            const emailCliente = session.customer_details?.email;

            if (!referenceUsername) return { statusCode: 200, body: 'Ignorado. Sin referencia de cliente.' };

            const lineItems = await stripe.checkout.sessions.listLineItems(session.id);
            const productTitle = lineItems.data[0].description.toLowerCase();

            let intervalo = '30 days'; let planNombre = 'Plan Mensual';
            if (productTitle.includes('14')) { intervalo = '14 days'; planNombre = 'Acceso 14 Días'; }
            else if (productTitle.includes('6 mes') || productTitle.includes('semestral')) { intervalo = '6 months'; planNombre = 'Plan Semestral'; }
            else if (productTitle.includes('anual') || productTitle.includes('año')) { intervalo = '1 year'; planNombre = 'Plan Anual'; }

            const isSub = session.mode === 'subscription';
            const client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });
            await client.connect();

            // ACTUALIZACIÓN CORREGIDA: Apuntamos a la tabla firmas usando el username de referencia
            const query = `
                UPDATE firmas 
                SET fecha_expiracion = CASE WHEN fecha_expiracion > CURRENT_DATE THEN fecha_expiracion + INTERVAL '${intervalo}' ELSE CURRENT_DATE + INTERVAL '${intervalo}' END,
                    stripe_subscription_id = $2, plan_nombre = $3, suscripcion_cancelada = false
                WHERE id_firma = (SELECT id_firma FROM usuarios_sistema WHERE username = $1 LIMIT 1) 
                RETURNING fecha_expiracion
            `;
            const res = await client.query(query, [referenceUsername, isSub ? session.subscription : null, planNombre]);
            await client.end();

            if (res.rows.length > 0 && emailCliente) {
                const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
                const fechaFmt = new Date(res.rows[0].fecha_expiracion).toLocaleDateString('es-MX', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
                await transporter.sendMail({
                    from: `"Vigilex ERP" <${process.env.EMAIL_USER}>`, to: emailCliente, subject: '✅ Renovación Aplicada Exitosamente',
                    html: `<div style="font-family: Arial, sans-serif; padding: 20px; color: #333;"><h2 style="color: #0a2540;">¡Renovación Exitosa!</h2><p>Tu vigencia institucional ha sido actualizada. La nueva fecha límite de tu Despacho es: <b>${fechaFmt.toUpperCase()}</b></p></div>`
                });
            }
        }
        return { statusCode: 200, body: JSON.stringify({ received: true }) };
    } catch (error) { return { statusCode: 400, body: `Webhook Error: ${error.message}` }; }
};