const { Client } = require('pg');
const jwt = require('jsonwebtoken');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    const client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });

    try {
        const { username, id_tarea, descripcion, fecha_vencimiento, categoria, asignado_a } = JSON.parse(event.body);

        // --- 1. BARRERA DE SEGURIDAD JWT ---
        const authHeader = event.headers.authorization || event.headers.Authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return { statusCode: 401, body: JSON.stringify({ error: 'No autorizado' }) };
        }

        try {
            jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
        } catch (err) {
            return { statusCode: 401, body: JSON.stringify({ error: 'Token inválido' }) };
        }

        await client.connect();

        // --- 2. OBTENER DATOS ACTUALES DE LA TAREA ---
        // Aquí extraemos todo lo necesario de la BD antes de modificarla
        const resPrevia = await client.query(`
            SELECT t.fecha_vencimiento, e.id_firma, e.numero_expediente, e.id_expediente
            FROM tareas_expediente t
            JOIN expedientes e ON t.id_expediente = e.id_expediente
            WHERE t.id_tarea = $1
        `, [id_tarea]);

        if (resPrevia.rows.length === 0) {
            await client.end();
            return { statusCode: 404, body: JSON.stringify({ error: 'Tarea no encontrada o sin expediente asociado' }) };
        }

        const dataAnterior = resPrevia.rows[0];

        // Formatear las fechas para compararlas de forma segura (YYYY-MM-DD)
        const fechaAntigua = dataAnterior.fecha_vencimiento ? new Date(dataAnterior.fecha_vencimiento).toISOString().split('T')[0] : null;
        const fechaNueva = fecha_vencimiento ? new Date(fecha_vencimiento).toISOString().split('T')[0] : null;

        // Iniciar transacción
        await client.query('BEGIN');

        // --- 3. ACTUALIZACIÓN PRINCIPAL DEL CRM ---
        // Simplificamos y blindamos el UPDATE. Usamos el id_expediente que acabamos de extraer.
        const queryUpdate = `
            UPDATE tareas_expediente
            SET descripcion = $1, fecha_vencimiento = $2, categoria = $3, asignado_a = $4
            WHERE id_tarea = $5 AND id_expediente = $6
        `;

        const resUpdate = await client.query(queryUpdate, [
            descripcion,
            fecha_vencimiento || null,
            categoria,
            asignado_a,
            id_tarea,
            dataAnterior.id_expediente
        ]);

        if (resUpdate.rowCount === 0) {
            throw new Error("No se pudo actualizar la tarea. Es posible que no tengas permisos.");
        }

        // --- 4. INYECCIÓN VIGISCORE (ANALÍTICA DE PRÓRROGAS) ---
        // Registramos una "PRORROGA" si la fecha cambió.
        // Ojo: Si antes no tenía fecha y ahora sí (o viceversa), también es un cambio.
        if (fechaAntigua !== fechaNueva) {
            try {
                // Creamos la tabla si no existe (con id_firma como VARCHAR para tu caso "3")
                await client.query(`
                    CREATE TABLE IF NOT EXISTS auditoria_tareas (
                        id_auditoria SERIAL PRIMARY KEY, 
                        id_firma VARCHAR(255), 
                        numero_expediente VARCHAR(100), 
                        nombre_tarea VARCHAR(255), 
                        abogado VARCHAR(100), 
                        accion VARCHAR(50), 
                        fecha_accion TIMESTAMP DEFAULT CURRENT_TIMESTAMP, 
                        fecha_vencimiento_tarea TIMESTAMP
                    );
                `);

                await client.query(`
                    INSERT INTO auditoria_tareas (id_firma, numero_expediente, nombre_tarea, abogado, accion, fecha_vencimiento_tarea)
                    VALUES ($1, $2, $3, $4, $5, $6)
                `, [
                    String(dataAnterior.id_firma),
                    dataAnterior.numero_expediente || 'Sin Número',
                    descripcion,
                    asignado_a || username,
                    'PRORROGA',
                    fecha_vencimiento || null
                ]);
            } catch (errAn) {
                console.error("Aviso: Error menor al guardar analítica de prórroga:", errAn.message);
                // No lanzamos el error para que la tarea sí se guarde.
            }
        }

        await client.query('COMMIT');
        await client.end();

        return { statusCode: 200, body: JSON.stringify({ success: true }) };

    } catch (error) {
        if (client) {
            try { await client.query('ROLLBACK'); } catch (e) { }
            await client.end();
        }
        console.error("Error Crítico al editar tarea:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message || 'Fallo interno al editar la tarea.' }) };
    }
};