const { Client } = require('pg');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    const client = new Client({
        connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED,
        ssl: { rejectUnauthorized: false }
    });

    try {
        // CAPTURAMOS nombreReal DESDE EL CUERPO DE LA PETICIÓN
        const { licencia, nombreFirma, nombreReal, username, password, email, codigo, hash } = JSON.parse(event.body);

        // 1. VALIDACIÓN DE SEGURIDAD (HASH)
        const hashCalculado = crypto.createHash('sha256').update(email + codigo + process.env.EMAIL_PASS).digest('hex');
        if (hashCalculado !== hash) {
            return { statusCode: 400, body: JSON.stringify({ error: 'El código de verificación es incorrecto.' }) };
        }

        await client.connect();

        // 2. VERIFICACIÓN DE LICENCIA
        const resLicencia = await client.query('SELECT * FROM licencias WHERE codigo = $1', [licencia.toUpperCase().trim()]);
        if (resLicencia.rows.length === 0) {
            await client.end();
            return { statusCode: 404, body: JSON.stringify({ error: 'La licencia ingresada es inexistente o ya ha sido utilizada.' }) };
        }

        const lic = resLicencia.rows[0];

        // Calcular fecha de expiración real
        let fechaExpiracion = null;
        if (lic.dias_vigencia) {
            const hoy = new Date();
            fechaExpiracion = new Date(hoy.setDate(hoy.getDate() + lic.dias_vigencia)).toISOString();
        } else if (lic.trial_end) {
            fechaExpiracion = lic.trial_end;
        }

        try {
            await client.query('BEGIN');

            // 3. CREAR EL DESPACHO (FIRMA) CON VIGENCIA CENTRALIZADA
            const insertFirmaQuery = `
                INSERT INTO firmas (nombre_comercial, plan_nombre, limite_usuarios, fecha_expiracion, stripe_subscription_id, en_prueba, trial_days, trial_end) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
                RETURNING id_firma
            `;
            const resFirma = await client.query(insertFirmaQuery, [
                nombreFirma.trim(),
                lic.plan_nombre || 'Plan Profesional',
                5, // Límite por defecto
                fechaExpiracion,
                lic.stripe_subscription_id,
                lic.en_prueba,
                lic.trial_days,
                lic.trial_end
            ]);

            const idFirmaGenerada = resFirma.rows[0].id_firma;

            // ENCRIPTACIÓN DE CONTRASEÑA
            const salt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash(password, salt);

            // 4. CREAR AL USUARIO COMO TITULAR VINCULADO (INCLUYENDO NOMBRE_REAL)
            const insertUserQuery = `
                INSERT INTO usuarios_sistema 
                (username, password_hash, nombre_firma, id_firma, rol_equipo, licencia_usada, email, nombre_real) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `;

            await client.query(insertUserQuery, [
                username.trim(),
                hashedPassword,
                nombreFirma.trim(),
                idFirmaGenerada,
                'titular',
                licencia.toUpperCase().trim(),
                email.trim(),
                nombreReal.trim() // <-- INSERTAMOS EL NOMBRE REAL AQUÍ
            ]);

            // 5. CONSUMIR LICENCIA
            await client.query('DELETE FROM licencias WHERE codigo = $1', [licencia.toUpperCase().trim()]);

            await client.query('COMMIT');
            await client.end();

            // --- NUEVO: GENERAR TOKEN PARA AUTO-LOGIN ---
            const tokenAcceso = jwt.sign(
                { username: username.trim(), rol: 'titular' },
                process.env.JWT_SECRET,
                { expiresIn: '12h' }
            );

            return {
                statusCode: 200,
                body: JSON.stringify({
                    success: true,
                    message: 'Despacho registrado y cuenta de titular activada correctamente.',
                    token: tokenAcceso,           // <-- Mandamos el token al frontend
                    username: username.trim()     // <-- Mandamos el usuario exacto
                })
            };

        } catch (dbError) {
            await client.query('ROLLBACK');
            throw dbError;
        }

    } catch (error) {
        if (client) await client.end();
        console.error('Error en crear_cuenta:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Fallo interno: ' + error.message })
        };
    }
};