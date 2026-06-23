const { Client } = require('pg');
const jwt = require('jsonwebtoken');

exports.handler = async function (event) {
    // Configuración de la conexión a PostgreSQL
    const client = new Client({
        connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED,
        ssl: { rejectUnauthorized: false }
    });

    try {
        // ==========================================
        //  1. BARRERA DE SEGURIDAD E IDENTIDAD (JWT)
        // ==========================================
        const authHeader = event.headers.authorization || event.headers.Authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return { statusCode: 401, body: JSON.stringify({ error: 'Acceso denegado. Token no proporcionado.' }) };
        }

        const token = authHeader.split(' ')[1];
        try {
            // Validamos que el token de la firma sea legal y no haya expirado
            jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            return { statusCode: 401, body: JSON.stringify({ error: 'Token de seguridad inválido o expirado.' }) };
        }

        // Extraemos el usuario individual directamente desde el encabezado personalizado (Privacidad absoluta)
        const usuarioIndividual = event.headers['x-usuario-operador'];

        if (!usuarioIndividual) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Identidad individual no detectada. Falta el encabezado de operador.' }) };
        }

        await client.connect();

        // ==========================================
        //  GET: OBTENER HISTORIAL Y KPIs
        // ==========================================
        if (event.httpMethod === 'GET') {
            const resMovimientos = await client.query(
                'SELECT * FROM finanzas_usuario WHERE username = $1 ORDER BY fecha_registro DESC LIMIT 50',
                [usuarioIndividual]
            );

            // Sumatoria inteligente: Balance Histórico + Lo de ESTE mes (aislado)
            const resTotales = await client.query(`
                SELECT 
                    SUM(CASE WHEN tipo = 'ingreso' THEN monto ELSE 0 END) as total_ingresos,
                    SUM(CASE WHEN tipo = 'egreso' THEN monto ELSE 0 END) as total_egresos,
                    SUM(CASE WHEN tipo = 'ingreso' AND DATE_TRUNC('month', fecha_registro) = DATE_TRUNC('month', CURRENT_DATE) THEN monto ELSE 0 END) as ingresos_mes,
                    SUM(CASE WHEN tipo = 'egreso' AND DATE_TRUNC('month', fecha_registro) = DATE_TRUNC('month', CURRENT_DATE) THEN monto ELSE 0 END) as egresos_mes
                FROM finanzas_usuario WHERE username = $1
            `, [usuarioIndividual]);

            // NUEVO: Calculamos los promedios mensuales matemáticamente
            const resPromedios = await client.query(`
                WITH meses AS (
                    SELECT 
                        DATE_TRUNC('month', fecha_registro) as mes,
                        SUM(CASE WHEN tipo = 'ingreso' THEN monto ELSE 0 END) as sum_ingreso,
                        SUM(CASE WHEN tipo = 'egreso' THEN monto ELSE 0 END) as sum_egreso
                    FROM finanzas_usuario 
                    WHERE username = $1
                    GROUP BY DATE_TRUNC('month', fecha_registro)
                )
                SELECT 
                    COALESCE(AVG(sum_ingreso), 0) as promedio_ingresos,
                    COALESCE(AVG(sum_egreso), 0) as promedio_egresos
                FROM meses
            `, [usuarioIndividual]);

            // Agrupamos el flujo neto (Ingresos - Egresos) de los últimos 6 meses para la gráfica
            const resGrafica = await client.query(`
                SELECT 
                    TO_CHAR(DATE_TRUNC('month', fecha_registro), 'YYYY-MM') as mes_anio,
                    SUM(CASE WHEN tipo = 'ingreso' THEN monto ELSE -monto END) as utilidad
                FROM finanzas_usuario 
                WHERE username = $1 AND fecha_registro >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '5 months'
                GROUP BY DATE_TRUNC('month', fecha_registro)
                ORDER BY DATE_TRUNC('month', fecha_registro) ASC
            `, [usuarioIndividual]);

            const stats = resTotales.rows[0];
            const promedios = resPromedios.rows[0] || { promedio_ingresos: 0, promedio_egresos: 0 };

            return {
                statusCode: 200,
                body: JSON.stringify({
                    success: true,
                    movimientos: resMovimientos.rows,
                    grafica: resGrafica.rows,
                    stats: {
                        balance: parseFloat(stats.total_ingresos || 0) - parseFloat(stats.total_egresos || 0),
                        ingresos_mes: parseFloat(stats.ingresos_mes || 0),
                        egresos_mes: parseFloat(stats.egresos_mes || 0),
                        promedio_ingresos: parseFloat(promedios.promedio_ingresos || 0),
                        promedio_egresos: parseFloat(promedios.promedio_egresos || 0)
                    }
                })
            };
        }

        // Parseamos el body de forma segura para los siguientes métodos
        const body = event.body ? JSON.parse(event.body) : {};

        // ==========================================
        //  POST: CREAR NUEVO MOVIMIENTO
        // ==========================================
        if (event.httpMethod === 'POST') {
            const { fecha, descripcion, monto, tipo, categoria } = body;

            if (!descripcion || !monto || !tipo) {
                return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Faltan datos obligatorios.' }) };
            }

            // Si el usuario no manda fecha, usamos la fecha y hora actual del servidor
            const fechaFinal = fecha ? fecha : new Date().toISOString();

            await client.query(
                'INSERT INTO finanzas_usuario (username, descripcion, monto, tipo, categoria, fecha_registro) VALUES ($1, $2, $3, $4, $5, $6)',
                [usuarioIndividual, descripcion, monto, tipo, categoria || 'General', fechaFinal]
            );

            return { statusCode: 200, body: JSON.stringify({ success: true, message: 'Movimiento registrado con éxito.' }) };
        }

        // ==========================================
        //  PUT: ACTUALIZAR MOVIMIENTO EXISTENTE
        // ==========================================
        if (event.httpMethod === 'PUT') {
            const { id, fecha, descripcion, monto, tipo } = body;

            if (!id || !descripcion || !monto || !tipo) {
                return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Faltan datos para procesar la actualización.' }) };
            }

            const fechaFinal = fecha ? fecha : new Date().toISOString();

            // Usamos "AND username = $6" para que nadie pueda editar movimientos que no le pertenecen
            const updateRes = await client.query(
                'UPDATE finanzas_usuario SET fecha_registro = $1, descripcion = $2, monto = $3, tipo = $4 WHERE id = $5 AND username = $6',
                [fechaFinal, descripcion, monto, tipo, id, usuarioIndividual]
            );

            if (updateRes.rowCount === 0) {
                return { statusCode: 404, body: JSON.stringify({ success: false, error: 'Movimiento no encontrado o sin permisos.' }) };
            }

            return { statusCode: 200, body: JSON.stringify({ success: true, message: 'Movimiento actualizado correctamente.' }) };
        }

        // ==========================================
        //  DELETE: ELIMINAR MOVIMIENTO
        // ==========================================
        if (event.httpMethod === 'DELETE') {
            const { id } = body;

            if (!id) {
                return { statusCode: 400, body: JSON.stringify({ success: false, error: 'No se especificó qué movimiento eliminar.' }) };
            }

            // Nuevamente, blindamos con "AND username = $2"
            const deleteRes = await client.query(
                'DELETE FROM finanzas_usuario WHERE id = $1 AND username = $2',
                [id, usuarioIndividual]
            );

            if (deleteRes.rowCount === 0) {
                return { statusCode: 404, body: JSON.stringify({ success: false, error: 'Movimiento no encontrado o sin permisos.' }) };
            }

            return { statusCode: 200, body: JSON.stringify({ success: true, message: 'Movimiento eliminado de forma permanente.' }) };
        }

        // Si se hace una petición con un método diferente (PATCH, OPTIONS, etc.)
        return { statusCode: 405, body: JSON.stringify({ error: 'Método no permitido por el servidor.' }) };

    } catch (error) {
        console.error("⛔ Error Crítico en crm_finanzas:", error);
        return { statusCode: 500, body: JSON.stringify({ success: false, error: 'Fallo interno en el servidor.' }) };
    } finally {
        await client.end();
    }
};