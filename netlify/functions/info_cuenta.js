const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Método no permitido' }) };

    const client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });

    try {
        const { username } = JSON.parse(event.body);
        if (!username) return { statusCode: 400, body: JSON.stringify({ success: false, error: "Usuario nulo" }) };

        const authHeader = event.headers?.authorization || event.headers?.Authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) return { statusCode: 401, body: JSON.stringify({ error: 'Token no proporcionado.' }) };
        try { jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); } catch (err) { return { statusCode: 401, body: JSON.stringify({ error: 'Token inválido o expirado.' }) }; }

        await client.connect();

        // Auto-Migración: Agrega la columna de conteo regresivo si no existe
        try { await client.query('ALTER TABLE firmas ADD COLUMN fecha_downgrade TIMESTAMP;'); } catch (e) { }

        const query = `
            SELECT 
                u.username, u.email, u.rol_equipo, u.nombre_firma, u.licencia_usada, u.nombre_real, u.id_firma,
                f.fecha_expiracion AS vto_firma, f.stripe_subscription_id AS sub_firma, 
                f.plan_nombre AS plan_firma, f.en_prueba AS prueba_firma,
                f.trial_end AS trial_end_firma, f.trial_days AS trial_days_firma,
                f.suscripcion_cancelada AS cancelada_firma, f.limite_usuarios,
                f.fecha_downgrade AS fecha_downgrade_firma
            FROM usuarios_sistema u
            LEFT JOIN firmas f ON u.id_firma = f.id_firma
            WHERE LOWER(u.username) = LOWER($1) LIMIT 1
        `;
        const res = await client.query(query, [username]);

        if (res.rows.length === 0) {
            await client.end();
            return { statusCode: 404, body: JSON.stringify({ success: false, error: "Usuario no encontrado" }) };
        }

        const user = res.rows[0];
        let facturas = [];
        let proximoCobroStripe = null;
        let planExacto = user.plan_firma || "Plan Institucional Profesional";
        let tipoAcceso = "Pago Único";

        if (user.sub_firma) {
            try {
                const sub = await stripe.subscriptions.retrieve(user.sub_firma);
                proximoCobroStripe = new Date(sub.current_period_end * 1000).toISOString();

                const interval = sub.items?.data[0]?.plan?.interval;
                const intervalCount = sub.items?.data[0]?.plan?.interval_count;
                if (interval === 'month' && intervalCount === 1) tipoAcceso = "Suscripción Mensual";
                else if (interval === 'month' && intervalCount === 6) tipoAcceso = "Suscripción Semestral";
                else if (interval === 'year') tipoAcceso = "Suscripción Anual";

                const invoices = await stripe.invoices.list({ subscription: user.sub_firma, limit: 10 });
                if (invoices.data.length > 0) {
                    const descStripe = String(invoices.data[0].lines?.data[0]?.description || '').toLowerCase();
                    if (descStripe.includes('personal')) planExacto = "Plan Personal";
                    else if (descStripe.includes('starter')) planExacto = "Plan Institucional Starter";
                    else if (descStripe.includes('pro')) planExacto = "Plan Institucional Profesional";
                }
                facturas = invoices.data.map(inv => ({
                    fecha: new Date(inv.created * 1000).toLocaleDateString('es-MX'),
                    descripcion: inv.lines?.data[0]?.description || 'Suscripción VIGILEX',
                    monto: `$${(inv.total / 100).toFixed(2)} ${String(inv.currency || 'MXN').toUpperCase()}`,
                    estado: inv.status === 'paid' ? 'Pagado' : 'Pendiente',
                    url_recibo: inv.hosted_invoice_url || '#'
                }));
            } catch (e) { console.log("Stripe Error:", e); }
        }

        let limiteReal = 99999;
        const planStr = String(planExacto).toLowerCase();
        if (planStr.includes('personal')) limiteReal = 1;
        else if (planStr.includes('starter')) limiteReal = 5;

        if (user.id_firma && (user.limite_usuarios !== limiteReal || user.plan_firma !== planExacto)) {
            try { await client.query('UPDATE firmas SET limite_usuarios = $1, plan_nombre = $2 WHERE id_firma = $3', [limiteReal, planExacto, user.id_firma]); } catch (e) { }
        }

        // ==========================================
        // LÓGICA DE INHABILITACIÓN Y AUTO-BORRADO
        // ==========================================
        let esExcedido = false;
        let cuentasExcedidas = 0;
        let diasParaBorrar = 0;

        if (user.id_firma) {
            // CORRECCIÓN CLAVE: Quitamos el ORDER BY id_usuario
            // Ahora ordenamos alfabéticamente por username para mantener un orden consistente en la prelación
            const teamRes = await client.query('SELECT username, rol_equipo FROM usuarios_sistema WHERE id_firma = $1 ORDER BY username ASC', [user.id_firma]);

            // Reordenamos para asegurar que los titulares/masters siempre estén primero y no sean inhabilitados
            let team = teamRes.rows;
            const titulares = team.filter(u => u.rol_equipo === 'titular' || u.rol_equipo === 'master');
            const abogados = team.filter(u => u.rol_equipo !== 'titular' && u.rol_equipo !== 'master');
            team = [...titulares, ...abogados];

            // Identificar si ESTE usuario en específico está inhabilitado
            let indexUsuario = team.findIndex(r => r.username === user.username);
            if (indexUsuario >= limiteReal && user.rol_equipo !== 'titular' && user.rol_equipo !== 'master') {
                esExcedido = true;
            }

            if (team.length > limiteReal) {
                cuentasExcedidas = team.length - limiteReal;

                if (!user.fecha_downgrade_firma) {
                    await client.query('UPDATE firmas SET fecha_downgrade = CURRENT_TIMESTAMP WHERE id_firma = $1', [user.id_firma]);
                    diasParaBorrar = 14;
                } else {
                    const diff = new Date() - new Date(user.fecha_downgrade_firma);
                    const diasPasados = Math.floor(diff / (1000 * 60 * 60 * 24));
                    diasParaBorrar = Math.max(0, 14 - diasPasados);

                    // SI LLEGÓ A CERO, BORRAMOS LAS CUENTAS EXCEDIDAS DE LA BASE DE DATOS
                    if (diasParaBorrar === 0) {
                        const usersToDelete = team.slice(limiteReal).map(r => r.username);
                        if (usersToDelete.length > 0) {
                            const placeholders = usersToDelete.map((_, i) => `$${i + 2}`).join(',');
                            await client.query(`DELETE FROM usuarios_sistema WHERE id_firma = $1 AND username IN (${placeholders})`, [user.id_firma, ...usersToDelete]);
                            await client.query('UPDATE firmas SET fecha_downgrade = NULL WHERE id_firma = $1', [user.id_firma]);
                            cuentasExcedidas = 0;

                            // Si el que intentó entrar es uno de los borrados, lo pateamos
                            if (usersToDelete.includes(user.username)) {
                                await client.end();
                                return { statusCode: 404, body: JSON.stringify({ success: false, error: "Tu cuenta ha sido eliminada permanentemente por expiración de plan." }) };
                            }
                        }
                    }
                }
            } else {
                if (user.fecha_downgrade_firma) await client.query('UPDATE firmas SET fecha_downgrade = NULL WHERE id_firma = $1', [user.id_firma]);
            }
        }
        await client.end();

        const cuenta = {
            username: user.username,
            nombre_real: user.nombre_real,
            email: user.email,
            nombre_firma: user.nombre_firma, // <--- ¡AQUÍ ESTÁ LA CORRECCIÓN!
            licencia_usada: (user.rol_equipo === 'titular' || user.rol_equipo === 'master') ? (user.licencia_usada || 'Suscripción directa') : `Licencia de ${user.nombre_firma || 'Firma'}`,
            fecha_expiracion: proximoCobroStripe || user.vto_firma,
            en_prueba: user.prueba_firma,
            trial_end: user.trial_end_firma,
            trial_days: user.trial_days_firma,
            stripe_subscription_id: user.sub_firma,
            plan_nombre: planExacto,
            tipo_acceso: tipoAcceso,
            suscripcion_cancelada: user.cancelada_firma,
            rol_equipo: user.rol_equipo,
            historial_facturas: facturas,
            limite_usuarios: limiteReal,
            es_excedido: esExcedido,
            cuentas_excedidas: cuentasExcedidas,
            dias_para_borrar: diasParaBorrar
        };

        return { statusCode: 200, body: JSON.stringify({ success: true, cuenta }) };
    } catch (error) {
        if (client) await client.end();
        console.error("Error completo:", error); // Añadido para debug
        return { statusCode: 500, body: JSON.stringify({ success: false, error: error.message }) };
    }
};