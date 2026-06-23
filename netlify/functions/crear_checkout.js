const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    try {
        const { username, price_id } = JSON.parse(event.body);
        const baseUrl = 'https://www.vigilex.mx';

        // Verificamos en Stripe si el ID es de suscripción o pago único
        const price = await stripe.prices.retrieve(price_id);
        const mode = price.type === 'recurring' ? 'subscription' : 'payment';

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{ price: price_id, quantity: 1 }],
            mode: mode,
            client_reference_id: username, // FUNDAMENTAL: Inyectamos el nombre de la firma aquí
            success_url: `${baseUrl}/lobby.html?pago=exito`,
            cancel_url: `${baseUrl}/lobby.html?pago=cancelado`,
        });

        return { statusCode: 200, body: JSON.stringify({ url: session.url }) };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};