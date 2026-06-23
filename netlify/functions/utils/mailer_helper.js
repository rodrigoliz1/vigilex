const nodemailer = require('nodemailer');

async function enviarCorreoVigilex(destinatario, asunto, titulo, mensaje, botonTexto = null, botonUrl = null) {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        console.log("Faltan credenciales de correo en las variables de entorno.");
        return;
    }

    // Conexión oficial a los servidores de Brevo
    let transporter = nodemailer.createTransport({
        host: "smtp-relay.brevo.com",
        port: 587,
        secure: false, // Brevo usa TLS en el puerto 587
        auth: { 
            user: process.env.EMAIL_USER, 
            pass: process.env.EMAIL_PASS 
        }
    });

    // Botón opcional dinámico
    let btnHtml = botonTexto ? `<div style="text-align: center; margin-top: 30px;"><a href="${botonUrl}" style="background-color: #ad974f; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 14px; display: inline-block; text-transform: uppercase; letter-spacing: 1px;">${botonTexto}</a></div>` : '';

    // Plantilla HTML Elegante
    let html = `
    <div style="font-family: 'Helvetica Neue', Arial, sans-serif; background-color: #f4f6f8; padding: 40px 20px; color: #333;">
        <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.05);">
            <div style="background-color: #0a2540; padding: 30px; text-align: center; border-bottom: 4px solid #ad974f;">
                <h1 style="color: white; margin: 0; font-size: 24px; font-weight: 300; letter-spacing: 2px;">VIGILEX <span style="font-weight: bold;">Network</span></h1>
            </div>
            <div style="padding: 40px 30px;">
                <h2 style="color: #0a2540; font-size: 20px; margin-top: 0; margin-bottom: 20px;">${titulo}</h2>
                <p style="font-size: 15px; line-height: 1.6; color: #555; margin: 0;">${mensaje}</p>
                ${btnHtml}
            </div>
            <div style="background-color: #f9f9f9; padding: 20px; text-align: center; border-top: 1px solid #eee; font-size: 12px; color: #999;">
                <p style="margin: 0;">Este es un mensaje automático de seguridad cifrada. No responda a este correo.</p>
                <p style="margin: 5px 0 0 0;">&copy; ${new Date().getFullYear()} VIGILEX Elite. Todos los derechos reservados.</p>
            </div>
        </div>
    </div>`;

    // Usamos el EMAIL_SENDER que configuraste en Netlify, si no, caemos por defecto al USER
    const sender = process.env.EMAIL_SENDER || process.env.EMAIL_USER;

    try { 
        await transporter.sendMail({ 
            from: `"VIGILEX Elite" <${sender}>`, 
            to: destinatario, 
            subject: asunto, 
            html: html 
        }); 
        console.log(`Correo enviado exitosamente a: ${destinatario}`);
    } catch (e) { 
        console.error("Error enviando correo con Brevo:", e); 
    }
}

// Exportamos la función para que otros archivos puedan usarla
module.exports = { enviarCorreoVigilex };