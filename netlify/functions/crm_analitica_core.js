const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Inicializamos la IA con tu llave explícita
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Helper con Fallback en Cascada Multinivel
async function llamarIA(contenido) {
    // Definimos el orden estricto de los motores
    const modelos = [
        "gemini-3.1-flash",
        "gemini-3.1-flash-lite",
        "gemini-3-flash",
        "gemini-2.5-flash"
    ];

    for (let i = 0; i < modelos.length; i++) {
        try {
            const model = genAI.getGenerativeModel({ model: modelos[i] });
            return await model.generateContent(contenido);

        } catch (error) {
            console.warn(`⚠️ Saturación en modelo IA. Saltando al siguiente motor...`);

            // Si ya probamos el último de la lista y también falló, lanzamos el error al sistema
            if (i === modelos.length - 1) {
                console.error("❌ Todos los motores se encuentran saturados, por favor intenta de nuevo en unos momentos.");
                throw error;
            }
        }
    }
}

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader) return { statusCode: 401, body: JSON.stringify({ error: 'No token' }) };
    try { jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); }
    catch (e) { return { statusCode: 401, body: JSON.stringify({ error: 'Token inválido' }) }; }

    let client;
    try {
        const { username, accion, contexto, pregunta } = JSON.parse(event.body);
        client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });
        await client.connect();

        const usrRes = await client.query('SELECT id_firma FROM usuarios_sistema WHERE username = $1', [username]);
        const idFirma = usrRes.rows[0].id_firma;

        // ======================================================================
        // ACCIÓN 1: GENERAR DASHBOARD ANALÍTICO (ARQUITECTURA HÍBRIDA ULTRA RÁPIDA)
        // ======================================================================
        if (accion === 'obtener_dashboard') {

            let queryExp = `
                SELECT e.numero_expediente, e.organo_jurisdiccional,
                       (SELECT fecha_resolucion FROM resoluciones_expediente WHERE id_expediente = e.id_expediente ORDER BY fecha_resolucion DESC LIMIT 1) as ultima_actuacion,
                       (SELECT COUNT(*) FROM bitacora_calculos WHERE id_expediente = e.id_expediente AND agotado = false) as plazos_activos
                FROM expedientes e
                WHERE e.id_firma = $1 AND e.estado_archivo = 'activo'
            `;
            const paramsExp = [idFirma];

            if (contexto && contexto !== 'TODOS') {
                queryExp += ` AND e.username = $2`;
                paramsExp.push(contexto);
            }

            const dbData = await client.query(queryExp, paramsExp);
            const expedientesRaw = dbData.rows;
            const totalActivos = expedientesRaw.length;

            if (totalActivos === 0) {
                await client.end();
                return { statusCode: 200, body: JSON.stringify({ success: true, vacio: true, total: 0 }) };
            }

            // 1. EL SERVIDOR HACE LAS MATEMÁTICAS EN 1 MILISEGUNDO
            const hoy = new Date();
            let sumDias = 0;
            let activosRiesgo = 0;
            let juzgadosMap = {};
            let pipe = [0, 0, 0, 0, 0];

            expedientesRaw.forEach(exp => {
                // Cálculo de inactividad
                let dias = 0;
                if (exp.ultima_actuacion) {
                    dias = Math.ceil(Math.abs(hoy - new Date(exp.ultima_actuacion)) / (1000 * 60 * 60 * 24));
                }
                exp.dias_inactividad = dias;
                sumDias += dias;
                if (dias > 60 || exp.plazos_activos === 0) activosRiesgo++;

                // Agrupación del Pipeline por Heurística (Tiempos procesales)
                if (dias < 15) pipe[0]++;
                else if (dias < 45) pipe[1]++;
                else if (dias < 90) pipe[2]++;
                else if (dias < 150) pipe[3]++;
                else pipe[4]++;

                // Agrupación de Juzgados
                const juz = exp.organo_jurisdiccional || 'Desconocido';
                if (!juzgadosMap[juz]) juzgadosMap[juz] = { nombre: juz, count: 0, sumDias: 0 };
                juzgadosMap[juz].count++;
                juzgadosMap[juz].sumDias += dias;
            });

            // KPIs Duros
            const promVelocidad = totalActivos > 0 ? Math.round(sumDias / totalActivos) : 0;
            const exito = totalActivos > 0 ? Math.max(10, 100 - Math.round((activosRiesgo / totalActivos) * 100)) : 100;

            // Top 3 Juzgados (Ordenados por carga de trabajo)
            const topJuzgados = Object.values(juzgadosMap)
                .sort((a, b) => b.count - a.count)
                .slice(0, 3)
                .map(j => {
                    let promJuz = Math.round(j.sumDias / j.count);
                    let velStr = promJuz < 20 ? "🟢 Rápido" : (promJuz < 60 ? "🟠 Medio" : "🔴 Lento");
                    return { nombre: j.nombre, carga: j.count + " exp", velocidad: velStr };
                });

            // 2. EXTRAEMOS SOLO EL "VENENO" PARA LA IA (Top 5 expedientes más inactivos)
            const criticos = expedientesRaw
                .sort((a, b) => b.dias_inactividad - a.dias_inactividad)
                .slice(0, 5)
                .map(e => ({ exp: e.numero_expediente, juzgado: e.organo_jurisdiccional, dias_inactivo: e.dias_inactividad, plazos: e.plazos_activos }));

            // 3. PROMPT MICROSCOPICO (Solo genera las Alertas, sin matemáticas)
            const prompt = `
                Eres "Vigilex AI", el Socio Analista. Aquí tienes los ${criticos.length} expedientes más críticos del despacho actualmente:
                ${JSON.stringify(criticos)}

                Escribe 3 alertas estratégicas de riesgo sobre estos expedientes. Devuelve ÚNICAMENTE un JSON válido con esta estructura exacta:
                {
                  "alertas": [
                    { "nivel": "roja", "icono": "🚨", "titulo": "Riesgo en Exp. X", "desc": "1 sola línea de consejo táctico" }
                  ]
                }
                Si algún expediente supera los 90 días inactivo, asígnale el nivel "roja", si no, "naranja".
            `;

            let alertasIA = [];
            try {
                // ⏱️ CRONÓMETRO DE SEGURIDAD REDUCIDO A 10 SEGUNDOS (Sobra tiempo)
                const timeoutHandler = new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT_IA")), 10000));
                const result = await Promise.race([llamarIA([prompt]), timeoutHandler]);

                let respuestaIA = result.response.text();
                respuestaIA = respuestaIA.substring(respuestaIA.indexOf('{'), respuestaIA.lastIndexOf('}') + 1);
                const datosIA = JSON.parse(respuestaIA);
                alertasIA = datosIA.alertas || [];
            } catch (error) {
                console.warn("⚠️ IA demoró en las alertas, generando alerta default.");
                alertasIA = [{ nivel: "naranja", icono: "⏱️", titulo: "Análisis Profundo", desc: "El servidor detectó riesgos, analizando estrategia de fondo..." }];
            }

            // 4. ENSAMBLAMOS EL DASHBOARD PERFECTO
            const datosAnalitica = {
                kpi_exito: exito + "%",
                kpi_riesgos: activosRiesgo,
                kpi_velocidad: promVelocidad,
                pipeline: pipe,
                juzgados: topJuzgados,
                alertas: alertasIA
            };

            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true, total: totalActivos, analitica: datosAnalitica }) };
        }

        // ======================================================================
        // ACCIÓN 2: SOCIO VIRTUAL (CHAT GLOBAL)
        // ======================================================================
        else if (accion === 'chat_socio_virtual') {
            const dbData = await client.query(`SELECT numero_expediente, materia, organo_jurisdiccional FROM expedientes WHERE id_firma = $1 AND estado_archivo = 'activo'`, [idFirma]);

            const prompt = `
                Eres "Vigilex AI", el Socio Analista. Supervisas globalmente estos asuntos:
                ${JSON.stringify(dbData.rows)}

                El usuario (abogado titular) te pregunta: "${pregunta}"
                Responde estratégico, ejecutivo y en Markdown. No saludes.
            `;

            const result = await llamarIA([prompt]);
            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true, respuesta: result.response.text() }) };
        }

        await client.end();
        return { statusCode: 400, body: JSON.stringify({ error: 'Acción no reconocida' }) };

    } catch (error) {
        if (client) await client.end();
        return { statusCode: 500, body: JSON.stringify({ error: "Fallo en el procesamiento de Big Data." }) };
    }
};