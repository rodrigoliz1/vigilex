const { Client } = require('pg');
const jwt = require('jsonwebtoken');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    const client = new Client({
        connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED,
        ssl: { rejectUnauthorized: false }
    });

    try {
        const { usuarioActual, targetUsername } = JSON.parse(event.body);
        if (!usuarioActual || !targetUsername) return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Faltan parámetros.' }) };

        const authHeader = event.headers.authorization || event.headers.Authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) return { statusCode: 401, body: JSON.stringify({ error: 'No autorizado' }) };
        try { jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); }
        catch (err) { return { statusCode: 401, body: JSON.stringify({ error: 'Token inválido' }) }; }

        await client.connect();

        const checkRes = await client.query('SELECT id_firma, rol_equipo FROM usuarios_sistema WHERE username = $1', [usuarioActual]);
        const targetRes = await client.query('SELECT id_firma, nombre_real FROM usuarios_sistema WHERE username = $1', [targetUsername]);

        if (checkRes.rows.length === 0 || targetRes.rows.length === 0) {
            await client.end(); return { statusCode: 404, body: JSON.stringify({ success: false, error: 'Usuario no encontrado.' }) };
        }

        const miRol = checkRes.rows[0].rol_equipo;
        const targetNombreReal = targetRes.rows[0].nombre_real || targetUsername;

        // 🛑 BARRERA DE SEGURIDAD BACKEND 🛑
        // Si no soy yo mismo, y además solo soy un 'abogado', corto la conexión inmediatamente.
        if (usuarioActual !== targetUsername && miRol === 'abogado') {
            await client.end();
            return {
                statusCode: 403,
                body: JSON.stringify({ success: false, error: 'No tienes permisos de administrador para ver las métricas de otro abogado.' })
            };
        }

        // =========================================================
        // EXTRACCIÓN DE DATOS REALES (ÚLTIMOS 30 DÍAS)
        // =========================================================

        let asuntosActivos = 0;
        let tareasLogradas = 0, plazosATiempo = 0, plazosTarde = 0, plazosVencidos = 0, prorrogas = 0;
        let tareasAprobadasDirecto = 0, tareasEnviadasACorregir = 0, horasRetrasoTotal = 0;
        let capturaExcelente = 0, capturaMala = 0;
        let auditoria = [];

        // A. Carga Operativa (Volumen real de Expedientes)
        try {
            const expRes = await client.query(`SELECT COUNT(*) as total FROM expedientes WHERE abogado_asignado = $1 AND estado_archivo = 'activo'`, [targetUsername]);
            asuntosActivos = parseInt(expRes.rows[0].total) || 0;
        } catch (e) { console.error("Error asuntos:", e); }

        // B. Tareas Vencidas ACTUALES
        try {
            const vencidasRes = await client.query(`
                SELECT COUNT(*) as total 
                FROM tareas_expediente 
                WHERE asignado_a = $1 
                  AND estado IN ('pendiente', 'en_revision', 'Corregir') 
                  AND fecha_vencimiento::date < CURRENT_DATE
            `, [targetUsername]);
            plazosVencidos = parseInt(vencidasRes.rows[0].total) || 0;
        } catch (e) { console.error("Error vencidas:", e); }

        // C. Efectividad de Plazos y Tasa de Fricción (Historial de Auditoría)
        try {
            const tareasRes = await client.query(`
                SELECT accion, fecha_accion, fecha_vencimiento_tarea, numero_expediente, nombre_tarea 
                FROM auditoria_tareas 
                WHERE abogado = $1 AND fecha_accion >= CURRENT_DATE - INTERVAL '30 days'
                ORDER BY fecha_accion DESC
            `, [targetUsername]);

            tareasRes.rows.forEach(t => {
                const vencimiento = t.fecha_vencimiento_tarea ? new Date(t.fecha_vencimiento_tarea) : null;
                const accionDate = new Date(t.fecha_accion);

                if (t.accion === 'Completada' || t.accion === 'A Presentar') {
                    tareasLogradas++;

                    if (t.accion === 'A Presentar') {
                        tareasAprobadasDirecto++;
                    }

                    if (vencimiento) {
                        vencimiento.setHours(23, 59, 59, 999);
                        if (accionDate <= vencimiento) { plazosATiempo++; }
                        else { plazosTarde++; horasRetrasoTotal += Math.abs(accionDate - vencimiento) / 36e5; }
                    } else {
                        plazosATiempo++;
                    }
                }
                else if (t.accion === 'A Corregir') {
                    tareasEnviadasACorregir++;
                }
                else if (t.accion === 'PRORROGA') {
                    prorrogas++;
                }
            });
        } catch (e) { console.log("Error tareas auditoria:", e); }

        const retrasoPromedio = (plazosTarde > 0) ? Math.round(horasRetrasoTotal / plazosTarde) : 0;

        // D. Agilidad de Captura de Resoluciones
        try {
            const resRes = await client.query(`
                SELECT fecha_resolucion, fecha_notificacion, fecha_creacion, tipo, numero_expediente 
                FROM resoluciones 
                WHERE creado_por = $1 AND fecha_creacion >= CURRENT_DATE - INTERVAL '30 days' 
                ORDER BY fecha_creacion DESC LIMIT 10
            `, [targetUsername]);

            resRes.rows.forEach(r => {
                const fechaPublicacion = r.fecha_notificacion || r.fecha_resolucion;
                if (fechaPublicacion && r.fecha_creacion) {
                    const fDato = new Date(fechaPublicacion);
                    const fCreacion = new Date(r.fecha_creacion);

                    const diffDias = Math.floor((fCreacion - fDato) / (1000 * 60 * 60 * 24));

                    let evalText = '', evalCode = '', rptaText = '';

                    if (diffDias <= 1) {
                        capturaExcelente++; evalText = 'Excelente'; evalCode = 'green'; rptaText = 'Mismo día/24h';
                    } else if (diffDias <= 3) {
                        capturaExcelente += 0.5; evalText = 'Aceptable'; evalCode = 'orange'; rptaText = `Retraso ${diffDias} días`;
                    } else {
                        capturaMala++; evalText = 'Penalización'; evalCode = 'red'; rptaText = `Crítico: +${diffDias} días`;
                    }

                    if (auditoria.length < 5) {
                        auditoria.push({ fecha: fCreacion.toLocaleDateString('es-MX'), exp: r.numero_expediente || 'N/A', desc: `Acuerdo: ${r.tipo}`, rpta: rptaText, eval: evalText, evalCode: evalCode });
                    }
                }
            });
        } catch (e) { console.log("Error resoluciones:", e); }

        await client.end();

        // =========================================================
        // 4. EL ALGORITMO VIGISCORE (MATEMÁTICA PURA BLINDADA)
        // =========================================================

        let factorEfectividad = 100;
        const totalTareas = plazosATiempo + plazosTarde + plazosVencidos;
        if (totalTareas > 0) factorEfectividad = (plazosATiempo / totalTareas) * 100;

        let factorAgilidad = 100;
        const totalCapturas = capturaExcelente + capturaMala;
        if (totalCapturas > 0) factorAgilidad = (capturaExcelente / totalCapturas) * 100;

        let factorCalidad = 100;
        const totalFriccion = tareasAprobadasDirecto + tareasEnviadasACorregir;
        if (totalFriccion > 0) factorCalidad = (tareasAprobadasDirecto / totalFriccion) * 100;

        let vigiscoreFinal = Math.round((factorEfectividad * 0.45) + (factorAgilidad * 0.35) + (factorCalidad * 0.20));

        if (tareasLogradas === 0 && capturaExcelente === 0 && capturaMala === 0 && tareasEnviadasACorregir === 0 && plazosVencidos === 0) {
            vigiscoreFinal = 0;
            auditoria.push({ fecha: '-', exp: '-', desc: 'Sin actividad reciente para evaluar.', rpta: '-', eval: 'Sin Datos', evalCode: 'orange' });
        }

        const payloadRespuesta = {
            nombre_real: targetNombreReal,
            vigiscore: vigiscoreFinal,
            kpis: {
                asuntos_activos: asuntosActivos,
                tareas_completadas: tareasLogradas,
                retraso_promedio_horas: retrasoPromedio,
                prorrogas: prorrogas
            },
            graficas: {
                plazos: { a_tiempo: plazosATiempo, tarde: plazosTarde, vencidas: plazosVencidos },
                friccion: { aprobadas_directo: tareasAprobadasDirecto, enviadas_a_corregir: tareasEnviadasACorregir }
            },
            auditoria: auditoria
        };

        return { statusCode: 200, body: JSON.stringify({ success: true, metricas: payloadRespuesta }) };

    } catch (error) {
        if (client) await client.end();
        console.error("ERROR CRÍTICO METRICAS:", error);
        return { statusCode: 500, body: JSON.stringify({ success: false, error: 'Error en el cálculo analítico.' }) };
    }
};