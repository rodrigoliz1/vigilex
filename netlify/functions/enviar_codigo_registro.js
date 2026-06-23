const nodemailer = require('nodemailer');
const crypto = require('crypto');

exports.handler = async function (event) {
    // Validar método
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    try {
        const { email } = JSON.parse(event.body);

        if (!email) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: 'El correo es obligatorio.' }) };
        }

        // Generar código de 6 dígitos
        const codigoOTP = Math.floor(100000 + Math.random() * 900000).toString();

        // Hashear el código para validarlo en el siguiente paso (Frontend)
        const hashCalculado = crypto.createHash('sha256').update(email.trim() + codigoOTP + process.env.EMAIL_PASS).digest('hex');

        // Configuración de Brevo (Garantizado que es correcta)
        const transporter = nodemailer.createTransport({
            host: 'smtp-relay.brevo.com',
            port: 587,
            secure: false, // true para 465, false para otros puertos
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });

        const sender = process.env.EMAIL_SENDER || process.env.EMAIL_USER;

        // ==========================================
        // PLANTILLA HTML PREMIUM Y PROFESIONAL
        // ==========================================
        const htmlEmail = `
        <!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin: 0; padding: 0; background-color: #f4f6f8; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f4f6f8; padding: 40px 20px;">
                <tr>
                    <td align="center">
                        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.05);">
                            
                            <tr>
                                <td style="background-color: #0a2540; padding: 40px 30px; text-align: center; border-bottom: 4px solid #ad974f;">
                                    <img src="https://www.vigilex.mx/logo-vigilex.png" alt="VIGILEX" style="width: 180px; height: auto; display: block; margin: 0 auto;">
                                </td>
                            </tr>
                            
                            <tr>
                                <td style="padding: 50px 40px;">
                                    <h1 style="color: #0a2540; font-size: 24px; font-weight: 700; margin: 0 0 20px 0; text-align: center; font-family: Georgia, serif;">Verificación de Identidad</h1>
                                    
                                    <p style="color: #555555; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0; text-align: center;">
                                        Estás a un paso de activar tu cuenta institucional en <strong>VIGILEX</strong>. Para garantizar la seguridad de tu información, necesitamos verificar tu dirección de correo electrónico.
                                    </p>
                                    
                                    <p style="color: #555555; font-size: 16px; line-height: 1.6; margin: 0 0 35px 0; text-align: center;">
                                        Por favor, ingresa el siguiente código de autorización en la plataforma:
                                    </p>

                                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                        <tr>
                                            <td align="center">
                                                <div style="background-color: #f8f9fa; border: 2px dashed #ad974f; border-radius: 12px; padding: 25px 40px; display: inline-block;">
                                                    <p style="margin: 0 0 10px 0; font-size: 11px; color: #888888; text-transform: uppercase; font-weight: 700; letter-spacing: 1px;">Código de Seguridad</p>
                                                    <p style="margin: 0; font-size: 42px; font-weight: 800; color: #0a2540; letter-spacing: 12px;">${codigoOTP}</p>
                                                </div>
                                            </td>
                                        </tr>
                                    </table>

                                    <div style="margin-top: 40px; border-top: 1px solid #eeeeee; padding-top: 25px;">
                                        <p style="color: #888888; font-size: 13px; line-height: 1.5; text-align: center; margin: 0;">
                                            Este código es válido por 15 minutos. Si no solicitaste este registro o no reconoces esta acción, puedes ignorar y eliminar este correo de forma segura.
                                        </p>
                                    </div>
                                </td>
                            </tr>
                            
                            <tr>
                                <td style="background-color: #f8f9fa; padding: 25px 40px; text-align: center; border-top: 1px solid #eeeeee;">
                                    <p style="margin: 0 0 10px 0; font-size: 12px; color: #999999; font-weight: 600;">
                                        VIGILEX | Departamento de Ciberseguridad
                                    </p>
                                    <p style="margin: 0; font-size: 11px; color: #aaaaaa;">
                                        © ${new Date().getFullYear()} Vigilex. Todos los derechos reservados.<br>
                                        Este es un mensaje generado automáticamente, por favor no respondas a este correo.
                                    </p>
                                </td>
                            </tr>
                            
                        </table>
                    </td>
                </tr>
            </table>
        </body>
        </html>`;

        // Intento de envío con captura de error específica de Nodemailer
        try {
            let info = await transporter.sendMail({
                from: `"VIGILEX Seguridad" <${sender}>`,
                to: email.trim(),
                subject: '🛡️ Código de Verificación para Registro - VIGILEX',
                html: htmlEmail
            });
            console.log("Correo enviado exitosamente. Message ID:", info.messageId);
        } catch (mailError) {
            console.error("⛔ ERROR CRÍTICO DE BREVO/NODEMAILER:", mailError);
            throw mailError; // Lanzamos el error para que el bloque catch principal lo atrape y devuelva el 500
        }

        // Si llega aquí, todo salió bien
        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, hash: hashCalculado })
        };

    } catch (error) {
        console.error("Error general en la función enviar_codigo_registro:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                success: false,
                error: 'Fallo al enviar el correo electrónico. Revisa los logs del servidor para más detalles.'
            })
        };
    }
};