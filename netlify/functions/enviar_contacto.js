const nodemailer = require('nodemailer');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    try {
        const { nombre, telefono, email, mensaje } = JSON.parse(event.body);

        if (!nombre || !telefono || !email || !mensaje) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Todos los campos son obligatorios.' }) };
        }

        const transporter = nodemailer.createTransport({
            host: 'smtp-relay.brevo.com',
            port: 587,
            secure: false,
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });
        const sender = process.env.EMAIL_SENDER || process.env.EMAIL_USER;

        const adminHtml = `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
            <div style="background-color: #0a2540; padding: 20px; text-align: center; border-bottom: 4px solid #ad974f;">
                <h2 style="color: white; margin: 0; font-family: 'Times New Roman', serif;">VIGILEX - Nuevo Contacto</h2>
            </div>
            <div style="padding: 30px; background-color: #ffffff;">
                <p style="font-size: 15px; margin-bottom: 20px;">Se ha recibido una nueva consulta desde el portal web:</p>
                
                <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                    <tr><td style="padding: 10px; border-bottom: 1px solid #eee;"><strong>Nombre:</strong></td><td style="padding: 10px; border-bottom: 1px solid #eee;">${nombre}</td></tr>
                    <tr><td style="padding: 10px; border-bottom: 1px solid #eee;"><strong>Teléfono / Celular:</strong></td><td style="padding: 10px; border-bottom: 1px solid #eee;">${telefono}</td></tr>
                    <tr><td style="padding: 10px; border-bottom: 1px solid #eee;"><strong>Correo Electrónico:</strong></td><td style="padding: 10px; border-bottom: 1px solid #eee;"><a href="mailto:${email}" style="color: #0277bd;">${email}</a></td></tr>
                </table>

                <div style="background-color: #f8f9fa; padding: 20px; border-left: 4px solid #ad974f; border-radius: 4px;">
                    <strong style="font-size: 12px; color: #666; text-transform: uppercase;">Mensaje / Consulta:</strong>
                    <p style="margin-top: 10px; font-size: 14px; line-height: 1.6; white-space: pre-wrap;">${mensaje}</p>
                </div>
            </div>
            <div style="background-color: #f4f6f8; padding: 15px; text-align: center; border-top: 1px solid #eee; font-size: 12px; color: #888;">
                Consulta generada automáticamente desde vigilex.mx/contacto
            </div>
        </div>`;

        await transporter.sendMail({
            from: `"Portal VIGILEX" <${sender}>`,
            to: 'soporte@vigilex.lat',
            replyTo: email,
            subject: `🔔 Nueva Consulta Comercial - ${nombre}`,
            html: adminHtml
        });

        const clienteHtml = `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
            <div style="background-color: #0a2540; padding: 30px; text-align: center; border-bottom: 4px solid #ad974f;">
                <img src="https://www.vigilex.mx/logo-vigilex.png" alt="VIGILEX" style="width: 160px;">
            </div>
            <div style="padding: 40px; background-color: #ffffff;">
                <h2 style="color: #0a2540; margin-top: 0; text-align: center; font-family: 'Times New Roman', serif;">Confirmación de Recepción</h2>
                <p style="font-size: 16px; line-height: 1.6; text-align: center;">
                    Estimado/a <strong>${nombre}</strong>,
                </p>
                <p style="font-size: 15px; line-height: 1.6; text-align: center; color: #555;">
                    Hemos recibido exitosamente su mensaje en nuestra central corporativa. Le agradecemos el interés en <strong>VIGILEX</strong>, el ecosistema digital diseñado para la excelencia jurídica.
                </p>

                <div style="background-color: #f8f9fa; border: 1px solid #e0e0e0; padding: 20px; margin: 30px 0; text-align: center; border-radius: 8px;">
                    <p style="margin: 0; font-size: 14px; color: #333; font-weight: bold;">
                        ⏳ Tiempo Estimado de Respuesta
                    </p>
                    <p style="margin: 8px 0 0 0; font-size: 13px; color: #666;">
                        Nuestro equipo de atención institucional y enlace comercial analizará su consulta y se pondrá en contacto con usted en un plazo no mayor a <strong>24 - 48 horas hábiles</strong>.
                    </p>
                </div>

                <p style="font-size: 13px; color: #888; text-align: center; border-top: 1px solid #eee; padding-top: 20px; font-style: italic;">
                    Para acelerar nuestro servicio, por favor tenga a la mano la información general del volumen de expedientes y abogados de su firma.
                </p>
            </div>
            <div style="background-color: #0a2540; padding: 20px; text-align: center; color: white;">
                <p style="margin: 0; font-size: 12px; opacity: 0.8;">VIGILEX | Dirección Comercial<br>Este es un correo automático (no-reply), por favor no responda a esta dirección.</p>
            </div>
        </div>`;

        await transporter.sendMail({
            from: `"VIGILEX Corporativo" <${sender}>`,
            to: email,
            subject: 'Recepción de Consulta - VIGILEX',
            html: clienteHtml
        });

        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error) {
        console.error("Error enviando contacto:", error);
        return { statusCode: 500, body: JSON.stringify({ success: false, error: 'Hubo un error interno al procesar tu solicitud.' }) };
    }
};