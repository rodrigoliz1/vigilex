const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require('googleapis');

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

    let client;
    try {
        const authHeader = event.headers.authorization || event.headers.Authorization;
        if (!authHeader) throw new Error("No token");
        jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);

        const { username, accion, cliente, datos, template_id } = JSON.parse(event.body);
        client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });
        await client.connect();

        if (accion === 'listar_clientes') {
            const res = await client.query(`SELECT cliente, COUNT(*) as total_exp FROM expedientes WHERE username = $1 AND estado_archivo = 'activo' GROUP BY cliente`, [username]);
            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true, clientes: res.rows }) };
        }

        else if (accion === 'analizar_cliente') {
            // EXTRAEMOS EL ORGANO JURISDICCIONAL
            const resExp = await client.query(`
                SELECT e.id_expediente, e.numero_expediente, e.materia, e.organo_jurisdiccional,
                (SELECT json_agg(r) FROM (
                    SELECT tipo, comentario, fecha_resolucion 
                    FROM resoluciones_expediente 
                    WHERE id_expediente = e.id_expediente 
                    AND fecha_resolucion >= CURRENT_DATE - INTERVAL '25 days'
                    ORDER BY fecha_resolucion DESC
                ) r) as acuerdos_recientes,
                (SELECT string_agg(tipo_parte || ': ' || nombre, '\n') 
                 FROM partes_expediente WHERE id_expediente = e.id_expediente) as listado_partes
                FROM expedientes e WHERE e.cliente = $1 AND e.username = $2 AND e.estado_archivo = 'activo'
            `, [cliente, username]);

            let resultadosAnalisis = [];

            for (const exp of resExp.rows) {
                let pretensionesStr = "Sin pretensiones registradas.";
                try {
                    const pretRes = await client.query(`SELECT contenido FROM textos_expediente WHERE id_expediente = $1 AND categoria LIKE '%PRETENSION%'`, [exp.id_expediente]);
                    if (pretRes.rows.length > 0) pretensionesStr = pretRes.rows.map(r => r.contenido).join('\n');
                } catch (e) { }

                const prompt = `
                    Eres un abogado comunicando avances a un cliente.
                    Analiza los acuerdos de los últimos 25 días del expediente ${exp.numero_expediente}:
                    ${JSON.stringify(exp.acuerdos_recientes || "Sin acuerdos en este periodo")}

                    Devuelve UNICAMENTE un JSON válido:
                    {
                      "expediente": "${exp.numero_expediente}",
                      "etapa": "Etapa procesal actual resumida",
                      "logros": "3 puntos logrados de forma clara (o 'El juzgado no emitió acuerdos relevantes en este periodo')",
                      "proyeccion": "Qué sigue en los próximos 30 días"
                    }
                `;

                try {
                    // Damos más tiempo de tolerancia a la IA
                    const timeoutHandler = new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), 15000));
                    const result = await Promise.race([llamarIA([prompt]), timeoutHandler]);

                    let txt = result.response.text();
                    txt = txt.substring(txt.indexOf('{'), txt.lastIndexOf('}') + 1);
                    const analizado = JSON.parse(txt);

                    analizado.materia = exp.materia || "Materia no especificada";
                    analizado.organo = exp.organo_jurisdiccional || "Órgano no especificado";
                    analizado.partes = exp.listado_partes || "Partes no especificadas";
                    analizado.pretensiones = pretensionesStr;

                    resultadosAnalisis.push(analizado);
                } catch (e) {
                    resultadosAnalisis.push({
                        expediente: exp.numero_expediente, etapa: "Análisis en revisión", logros: "Recopilando datos...", proyeccion: "-",
                        materia: exp.materia || "", organo: exp.organo_jurisdiccional || "", partes: exp.listado_partes || "", pretensiones: pretensionesStr
                    });
                }
            }

            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true, analisis: resultadosAnalisis }) };
        }

        else if (accion === 'crear_google_slides') {
            const usrRes = await client.query('SELECT * FROM usuarios_sistema WHERE username = $1', [username]);
            const usr = usrRes.rows[0];

            if (!usr.google_access_token) throw new Error("Google Drive no conectado.");

            const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
            auth.setCredentials({ access_token: usr.google_access_token, refresh_token: usr.google_refresh_token });

            const slides = google.slides({ version: 'v1', auth });
            const drive = google.drive({ version: 'v3', auth });

            const nombreFirma = usr.nombre_firma || usr.nombre_despacho || "FIRMA LEGAL";

            const copyRes = await drive.files.copy({
                fileId: template_id,
                requestBody: { name: `Reporte Corporativo: ${cliente} - ${new Date().toLocaleDateString()}` }
            });
            const newPresentationId = copyRes.data.id;

            const presentation = await slides.presentations.get({ presentationId: newPresentationId });

            let slideTemplateId = null;
            for (const slide of presentation.data.slides) {
                if (JSON.stringify(slide).includes('{{expediente}}') || JSON.stringify(slide).includes('{{EXPEDIENTE}}')) {
                    slideTemplateId = slide.objectId;
                    break;
                }
            }

            if (!slideTemplateId) throw new Error("No se encontró la etiqueta {{expediente}} en la plantilla.");

            let requests = [];

            const reemplazosGlobales = [
                { buscar: '{{CLIENTE}}', por: cliente },
                { buscar: '{{nombre_firma}}', por: nombreFirma }
            ];
            reemplazosGlobales.forEach(r => {
                requests.push({ replaceAllText: { containsText: { text: r.buscar, matchCase: false }, replaceText: String(r.por) } });
            });

            datos.forEach((asunto, index) => {
                const newSlideId = `ExpSlide_${index}`;

                requests.push({
                    duplicateObject: {
                        objectId: slideTemplateId,
                        objectIds: { [slideTemplateId]: newSlideId }
                    }
                });

                // AGREGAMOS {{organo}} AL DICCIONARIO DE REEMPLAZOS
                const reemplazosPorSlide = [
                    { buscar: '{{expediente}}', por: asunto.expediente || 'N/D' },
                    { buscar: '{{organo}}', por: asunto.organo || 'N/D' },
                    { buscar: '{{materia}}', por: asunto.materia || 'N/D' },
                    { buscar: '{{PARTES}}', por: asunto.partes || 'No especificadas' },
                    { buscar: '{{pretensiones}}', por: asunto.pretensiones || 'No definidas' },
                    { buscar: '{{ETAPA}}', por: asunto.etapa || 'En trámite' },
                    { buscar: '{{LOGROS}}', por: asunto.logros || 'Sin avances' },
                    { buscar: '{{PROYECCION}}', por: asunto.proyeccion || 'Continuación del proceso' }
                ];

                reemplazosPorSlide.forEach(r => {
                    requests.push({
                        replaceAllText: {
                            containsText: { text: r.buscar, matchCase: false },
                            replaceText: String(r.por),
                            pageObjectIds: [newSlideId]
                        }
                    });
                });
            });

            requests.push({ deleteObject: { objectId: slideTemplateId } });

            await slides.presentations.batchUpdate({ presentationId: newPresentationId, requestBody: { requests } });

            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true, url: `https://docs.google.com/presentation/d/${newPresentationId}/edit` }) };
        }

        await client.end();
        return { statusCode: 400, body: JSON.stringify({ error: 'Acción no reconocida' }) };

    } catch (error) {
        if (client) await client.end();
        console.error("Error Atencion Core:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};