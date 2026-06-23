const { Client } = require('pg');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    try {
        const { username } = JSON.parse(event.body);
        const client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });

        // --- 1. BARRERA DE SEGURIDAD JWT (EL CADENERO) ---
        const jwt = require('jsonwebtoken');
        const authHeader = event.headers.authorization || event.headers.Authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return { statusCode: 401, body: JSON.stringify({ error: 'Acceso denegado. Token no proporcionado.' }) };
        }

        const token = authHeader.split(' ')[1];
        let tokenDecodificado;

        try {
            tokenDecodificado = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            return { statusCode: 401, body: JSON.stringify({ error: 'Acceso denegado. Token inválido o expirado.' }) };
        }
        // Opcional: Puedes usar tokenDecodificado.username en lugar del username del body para mayor seguridad
        // --------------------------------------------------

        await client.connect();

        let notificacionesFinales = [];

        // 1. OBTENER NOTIFICACIONES DE LA BASE DE DATOS (Tareas asignadas, Eventos)
        const notifQuery = `
            SELECT id_notificacion, titulo, mensaje, tipo, fecha_creacion, url_accion 
            FROM notificaciones 
            WHERE username_destino = $1 AND leida = FALSE 
            ORDER BY fecha_creacion DESC
        `;
        const resNotif = await client.query(notifQuery, [username]);

        resNotif.rows.forEach(n => {
            notificacionesFinales.push({
                id: n.id_notificacion,
                titulo: n.titulo,
                mensaje: n.mensaje,
                tipo: n.tipo, // 'tarea', 'evento', etc.
                fecha: n.fecha_creacion,
                url: n.url_accion
            });
        });

        // 2. MOTOR DINÁMICO DE VENCIMIENTOS (Plazos y Tareas a 0, 1 o 2 días)
        const urgentesQuery = `
            SELECT t.descripcion, t.fecha_vencimiento, e.numero_expediente 
            FROM tareas_expediente t
            JOIN expedientes e ON t.id_expediente = e.id_expediente
            WHERE t.asignado_a = $1 
              AND t.estado = 'pendiente' 
              AND t.fecha_vencimiento IS NOT NULL
              AND t.fecha_vencimiento <= CURRENT_DATE + INTERVAL '2 days'
        `;
        const resUrgentes = await client.query(urgentesQuery, [username]);

        const hoy = new Date();
        hoy.setHours(0, 0, 0, 0);

        resUrgentes.rows.forEach(t => {
            const fechaVenc = new Date(t.fecha_vencimiento);
            fechaVenc.setHours(0, 0, 0, 0);

            const diffTime = fechaVenc - hoy;
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            let severidad = '';
            let colorStr = '';
            let tituloAlerta = '';

            if (diffDays <= 0) {
                severidad = 'urgente-rojo'; colorStr = '🔴'; tituloAlerta = '¡VENCE HOY!';
            } else if (diffDays === 1) {
                severidad = 'urgente-naranja'; colorStr = '🟠'; tituloAlerta = 'Vence Mañana';
            } else if (diffDays === 2) {
                severidad = 'urgente-amarillo'; colorStr = '🟡'; tituloAlerta = 'Vence en 2 días';
            }

            if (severidad !== '') {
                notificacionesFinales.push({
                    id: 'dinamica_' + Math.random(),
                    titulo: `${colorStr} ${tituloAlerta}: ${t.numero_expediente}`,
                    mensaje: t.descripcion,
                    tipo: severidad,
                    fecha: new Date().toISOString(),
                    url: 'expedientes.html'
                });
            }
        });

        await client.end();

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                notificaciones: notificacionesFinales
            })
        };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Fallo al obtener notificaciones.' }) };
    }
};