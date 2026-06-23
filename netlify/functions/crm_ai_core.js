const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require('googleapis');
const stream = require('stream');

// Inicializamos Gemini con la llave de entorno guardada en Netlify
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ======================================================================
// HELPER GLOBAL: CASCADA MULTINIVEL DE IA (High Availability)
// ======================================================================
async function llamarIA(contenido) {
    // Lista depurada y oficial (Abril 2026)
    const modelos = [
        "gemini-2.5-flash",               // El caballo de batalla principal
        "gemini-2.5-flash-lite",          // El más rápido de la serie estable
        "gemini-2.5-pro",                 // Estable y robusto
        "gemini-3.1-pro-preview",         // El más inteligente
        "gemini-3.1-flash-lite-preview"  // Nueva generación económica
    ];

    for (let i = 0; i < modelos.length; i++) {
        try {
            const model = genAI.getGenerativeModel({ model: modelos[i] });
            return await model.generateContent(contenido);
        } catch (error) {
            console.warn(`⚠️ Fallo en ${modelos[i]}: ${error.message}. Saltando al siguiente motor...`);
            if (i === modelos.length - 1) {
                console.error("❌ Todos los motores de la cascada fallaron.");
                throw error;
            }
        }
    }
}

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };

    // 1. Verificación de Seguridad VIGILEX
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader) return { statusCode: 401, body: JSON.stringify({ error: 'No token' }) };
    try {
        jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    } catch (e) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Token inválido' }) };
    }

    let client;
    try {
        const { username, accion, payload } = JSON.parse(event.body);

        client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED, ssl: { rejectUnauthorized: false } });
        await client.connect();

        // ======================================================================
        // FUNCIÓN 1: LECTURA Y RESUMEN AUTÓNOMO DE RESOLUCIONES (TEXTO, PDF Y DRIVE)
        // ======================================================================
        if (accion === 'analizar_resolucion') {
            const { id_expediente, texto_boletin, pdf_base64, drive_link, modo, cuaderno, tipo_notificacion, fecha_notificacion } = payload;
            let finalPdfBase64 = pdf_base64;

            if (modo === 'drive') {
                const usrRes = await client.query('SELECT google_access_token, google_refresh_token FROM usuarios_sistema WHERE username = $1', [username]);
                const usr = usrRes.rows[0];

                if (!usr.google_access_token) throw new Error("Debes conectar tu cuenta de Google Drive en el panel central.");
                const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
                oauth2Client.setCredentials({ access_token: usr.google_access_token, refresh_token: usr.google_refresh_token });
                const drive = google.drive({ version: 'v3', auth: oauth2Client });

                const match = drive_link.match(/\/d\/(.+?)\//) || drive_link.match(/id=(.+?)(&|$)/);
                if (!match) throw new Error("Enlace de Google Drive no válido.");
                try {
                    const driveRes = await drive.files.get({ fileId: match[1], alt: 'media' }, { responseType: 'arraybuffer' });
                    finalPdfBase64 = Buffer.from(driveRes.data).toString('base64');
                } catch (e) { throw new Error("No se pudo leer el archivo de Drive. Asegúrate de tener permisos."); }
            }

            let contenidoPrompt = [];

            if ((modo === 'pdf' || modo === 'drive') && finalPdfBase64) {
                contenidoPrompt.push({ inlineData: { data: finalPdfBase64, mimeType: "application/pdf" } });
                contenidoPrompt.push("Analiza detenidamente este documento PDF judicial. ");
            } else {
                contenidoPrompt.push(`Analiza el siguiente texto extraído de un boletín judicial: "${texto_boletin}". `);
            }

            contenidoPrompt.push(`
                Eres "Vigilex AI", un abogado analista experto en derecho mexicano.
                Extrae la información y devuelve ÚNICAMENTE un objeto JSON válido con la siguiente estructura exacta:
                {
                  "tipo": "Clasifícalo estrictamente como 'Auto', 'Interlocutoria', 'Sentencia' o 'Decreto'",
                  "fecha_dictada": "Extrae la fecha en la que se dictó el acuerdo en formato YYYY-MM-DD. Si no se menciona, devuelve null",
                  "sentido": "Una frase de 3 a 5 palabras con el sentido principal",
                  "comentario": "Un resumen ejecutivo, impecable y profesional de máximo 4 líneas sobre lo que ordenó el juez."
                }
            `);

            // Usamos la cascada global
            const result = await llamarIA(contenidoPrompt);
            let respuestaIA = result.response.text();

            const inicioJson = respuestaIA.indexOf('{');
            const finJson = respuestaIA.lastIndexOf('}') + 1;
            if (inicioJson !== -1 && finJson !== -1) respuestaIA = respuestaIA.substring(inicioJson, finJson);

            const datosIA = JSON.parse(respuestaIA);

            let fechaPublicacion = 'CURRENT_DATE';

            if (tipo_notificacion === 'Lista/Boletin' && datosIA.fecha_dictada) {
                const [y, m, d] = datosIA.fecha_dictada.split('-');
                let fechaCalculada = new Date(y, m - 1, d);
                fechaCalculada.setDate(fechaCalculada.getDate() + 1);

                if (fechaCalculada.getDay() === 6) fechaCalculada.setDate(fechaCalculada.getDate() + 2);
                else if (fechaCalculada.getDay() === 0) fechaCalculada.setDate(fechaCalculada.getDate() + 1);

                const pad = n => String(n).padStart(2, '0');
                fechaPublicacion = `'${fechaCalculada.getFullYear()}-${pad(fechaCalculada.getMonth() + 1)}-${pad(fechaCalculada.getDate())}'`;
            }

            const sintesisFinal = `🎯 ${datosIA.sentido}\n\n${datosIA.comentario}`;

            const resDB = await client.query(`
                INSERT INTO resoluciones_expediente 
                (id_expediente, tipo, fecha_resolucion, fecha_publicacion, comentario, cuaderno, tipo_notificacion, fecha_notificacion, creado_por) 
                VALUES ($1, $2, $3, ${fechaPublicacion}, $4, $5, $6, $7, 'Vigilex AI')
                RETURNING id_resolucion
            `, [
                id_expediente,
                datosIA.tipo || 'Auto',
                datosIA.fecha_dictada || null,
                sintesisFinal,
                cuaderno || 'Principal',
                tipo_notificacion,
                fecha_notificacion || null
            ]);

            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true, datos_ia: datosIA, id_resolucion: resDB.rows[0].id_resolucion }) };
        }

        // ======================================================================
        // FUNCIÓN 2: EL ESTRATEGA (CHAT INTERNO POR EXPEDIENTE)
        // ======================================================================
        else if (accion === 'estrategia_chat') {
            const { id_expediente, pregunta } = payload;

            const expRes = await client.query(`
                SELECT e.numero_expediente, e.cliente, e.organo_jurisdiccional, e.materia, e.via_procedimiento, e.notas, e.drive_folder_id,
                       u.google_access_token, u.google_refresh_token
                FROM expedientes e
                JOIN usuarios_sistema u ON u.username = $2
                WHERE e.id_expediente = $1
            `, [id_expediente, username]);

            const partesRes = await client.query('SELECT tipo_parte, nombre FROM partes_expediente WHERE id_expediente = $1', [id_expediente]);
            const resolucionesRes = await client.query('SELECT tipo, fecha_resolucion, comentario FROM resoluciones_expediente WHERE id_expediente = $1 ORDER BY fecha_resolucion ASC', [id_expediente]);
            const terminosRes = await client.query('SELECT materia as concepto, fecha_inicio, fecha_fin as vencimiento, agotado FROM bitacora_calculos WHERE id_expediente = $1 ORDER BY fecha_fin ASC', [id_expediente]);

            const exp = expRes.rows[0];

            let contextoDocumentos = "";
            let contenidoPrompt = [];
            let textoPregunta = pregunta;

            if (exp.drive_folder_id && exp.google_access_token) {
                try {
                    const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
                    oauth2Client.setCredentials({ access_token: exp.google_access_token, refresh_token: exp.google_refresh_token });
                    const drive = google.drive({ version: 'v3', auth: oauth2Client });

                    const resDrive = await drive.files.list({
                        q: `'${exp.drive_folder_id}' in parents`,
                        fields: 'files(name)',
                        pageSize: 20
                    });

                    if (resDrive.data.files && resDrive.data.files.length > 0) {
                        const lista = resDrive.data.files.map(f => `- ${f.name}`).join('\n');
                        contextoDocumentos = `\n--- DOCUMENTOS EN LA CARPETA DRIVE DE ESTE ASUNTO ---\n${lista}\n`;
                    } else {
                        contextoDocumentos = `\n--- DOCUMENTOS EN CARPETA DRIVE ---\nLa carpeta vinculada actualmente está vacía.\n`;
                    }
                } catch (e) { console.error("Error al leer Drive para el chat del expediente:", e); }
            }

            const matchFile = pregunta.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || pregunta.match(/id=([a-zA-Z0-9_-]+)/);
            if (matchFile && exp.google_access_token) {
                try {
                    const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
                    oauth2Client.setCredentials({ access_token: exp.google_access_token, refresh_token: exp.google_refresh_token });
                    const drive = google.drive({ version: 'v3', auth: oauth2Client });

                    const fileId = matchFile[1];
                    const driveRes = await drive.files.get({ fileId: fileId, alt: 'media' }, { responseType: 'arraybuffer' });
                    const pdfBase64 = Buffer.from(driveRes.data).toString('base64');

                    contenidoPrompt.push({ inlineData: { data: pdfBase64, mimeType: "application/pdf" } });
                    textoPregunta += "\n\n[Nota Interna: He descargado el PDF que me enlazaste. Analízalo.]";
                } catch (error) {
                    textoPregunta += "\n\n[Nota Interna: Hubo un error al descargar el PDF enlazado. Avisa al usuario.]";
                }
            }

            // ======================================================================
            // BIBLIOTECA UNIVERSAL VIGILEX (ARQUITECTURA FEDERAL/ESTATAL)
            // ======================================================================
            // 1. Apuntamos a la cuenta Maestra de VIGILEX (adminvigilex)
            const masterRes = await client.query(`
                SELECT google_access_token, google_refresh_token 
                FROM usuarios_sistema 
                WHERE username = 'adminvigilex' 
                AND google_access_token IS NOT NULL 
                LIMIT 1
            `);

            const masterToken = masterRes.rows[0];

            // 2. MAPEO DE ARCHIVOS EN TU DRIVE DE VIGILEX POR COMPETENCIA

            // A) LEYES GENERALES (Se cargan SIEMPRE, sin importar la materia. Ej. CPEUM)
            const LEYES_GENERALES = ['1D0ZXOkREK5vB4G3XjufnGZu2qyJzGT5F']; //Constitución Política de los Estados Unidos Mexicanos
            const LEYES_FEDERALES = {
                'Mercantil': ['1ZXWMA4Wq8jTBrl11bcYKivPq5K3Eaf8d', 'ID_JURIS_MERCANTIL_FED'],
                'Fiscal': ['1dk2ateeOnEPWXt8p2rlmjtURkNAEYxWX'],
                'Penal': ['1X6Koq2pIf-vDYa3O32gQPBcZI2goWU1d', '1y5bVOvDGGEAuLYTWk1P7CPDOP2sRfIWI'],
                'Juicio de Amparo': ['1aIm5-LiK_t_KWWpuL1vPoNGWLDtHlxAV', '1EqqkEVo2FTJ7dKHIdC2A1Hwr76KaXi_J'],
                'Civil_Federal': ['1MOnv0jAk0zpj31-VvL9b829ID1k0tyFu', '1EqqkEVo2FTJ7dKHIdC2A1Hwr76KaXi_J', '1Lwv1i-uoAKjPWYDsMsDC2PWhQaZ9R_oJ']
            };
            const LEYES_JALISCO = {
                'Civil': ['1A0tWf6XVuk_GUeqOoslg2e09pHrapFcx', '1hmV1ENaJgq2-yTJsGYYPX_3uuI6057RJ'],
                'Familiar': ['1A0tWf6XVuk_GUeqOoslg2e09pHrapFcx', '1hmV1ENaJgq2-yTJsGYYPX_3uuI6057RJ', 'ID_JURIS_FAMILIAR_JALISCO']
            };

            // (En el futuro agregar const LEYES_CDMX = {...} aquí mismo)

            // 3. Extracción e Inyección de Fuentes Legales
            if (masterToken) {
                try {
                    const oauthVigilex = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
                    oauthVigilex.setCredentials({ access_token: masterToken.google_access_token, refresh_token: masterToken.google_refresh_token });
                    const driveVigilex = google.drive({ version: 'v3', auth: oauthVigilex });

                    // Sumamos: Constitución + Ley Federal (si aplica) + Ley Estatal (si aplica)
                    const leyesFed = LEYES_FEDERALES[exp.materia] || [];
                    const leyesJal = LEYES_JALISCO[exp.materia] || [];

                    const archivosLeer = [...LEYES_GENERALES, ...leyesFed, ...leyesJal];

                    // Recorremos la lista final de archivos y descargamos cada TXT
                    for (let i = 0; i < archivosLeer.length; i++) {
                        const fileIdLey = archivosLeer[i];
                        if (fileIdLey && fileIdLey.length > 15 && !fileIdLey.startsWith('ID_')) {
                            try {
                                const driveResLey = await driveVigilex.files.get({ fileId: fileIdLey, alt: 'media' }, { responseType: 'arraybuffer' });
                                const textoLey = Buffer.from(driveResLey.data).toString('utf-8').substring(0, 2500000); // Límite seguro de 2.5M de caracteres
                                contenidoPrompt.push(`\n--- LEGISLACIÓN OFICIAL #${i + 1} ---\n${textoLey}\n-----------------------\n`);
                            } catch (e) {
                                console.warn("No se pudo descargar la ley:", fileIdLey);
                            }
                        }
                    }

                    textoPregunta += `\n\n[SISTEMA VIGILEX: Se han adjuntado los archivos TXT oficiales de Legislación General, Federal y del Estado de Jalisco. Es OBLIGATORIO que bases tus respuestas ÚNICA Y EXCLUSIVAMENTE en estos documentos de texto. No uses conocimientos externos.]`;
                } catch (errorLey) {
                    console.warn("⚠️ Biblioteca Central inaccesible:", errorLey.message);
                }
            }
            // ======================================================================

            const limpiarHTML = (html) => html ? html.replace(/<[^>]+>/g, ' ') : 'Sin notas';
            const formatearFecha = (d) => d ? new Date(d).toISOString().split('T')[0] : 'Sin fecha';

            let contextoTotal = `
            EXPEDIENTE SELECCIONADO:
            - Número: ${exp.numero_expediente}
            - Cliente: ${exp.cliente || 'Desconocido'}
            - Juzgado/Tribunal: ${exp.organo_jurisdiccional}
            - Materia/Vía: ${exp.materia} / ${exp.via_procedimiento}
            ${contextoDocumentos}
            
            PARTES INVOLUCRADAS:
            ${partesRes.rows.map(p => `- ${p.tipo_parte}: ${p.nombre}`).join('\n')}

            NOTAS DEL EXPEDIENTE:
            "${limpiarHTML(exp.notas)}"

            HISTORIAL DE RESOLUCIONES:
            ${resolucionesRes.rows.length > 0 ? resolucionesRes.rows.map(r => `> [${formatearFecha(r.fecha_resolucion)}] ${r.tipo}: ${r.comentario}`).join('\n') : 'No hay acuerdos.'}

            PLAZOS COMPUTADOS:
            ${terminosRes.rows.length > 0 ? terminosRes.rows.map(t => `> ${t.concepto} | Inició: ${formatearFecha(t.fecha_inicio)} | Vence: ${formatearFecha(t.vencimiento)} | Estado: ${t.agotado ? 'AGOTADO' : 'PENDIENTE'}`).join('\n') : 'No hay plazos.'}
            `;

            contenidoPrompt.push(`
            Eres "Vigilex AI", el estratega legal de VIGILEX asignado a este expediente.
            Analiza el contexto ÍNTEGRO del asunto:
            
            <INICIO DEL CONTEXTO>
            ${contextoTotal}
            <FIN DEL CONTEXTO>
            
            El usuario te consulta:
            "${textoPregunta}"
            
            INSTRUCCIONES Y REGLAS DE ORO (ESTRICTAS):
            1. EXCLUSIVIDAD DE FUENTES: Debes responder a las consultas jurídicas basándote ÚNICA Y EXCLUSIVAMENTE en los PDFs de Legislación, Tesis y Jurisprudencias adjuntos por el sistema.
            2. CERO ALUCINACIONES: Si la respuesta o el fundamento legal no se encuentra en los PDFs proporcionados de la Biblioteca Central, DEBES declarar: "La biblioteca legal cargada no contempla información suficiente para responder esto". No adivines ni inventes artículos.
            3. CITAS EXACTAS: Al fundamentar, menciona exactamente el artículo, número de tesis o rubro jurisprudencial tal como aparece en los PDFs.
            4. Responde de manera analítica y ejecutiva usando formato Markdown. No saludes, ve directo al análisis.
            `);

            try {
                const timeoutHandler = new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT_IA")), 25000));

                // Usamos la cascada global compitiendo con el cronómetro
                const result = await Promise.race([
                    llamarIA(contenidoPrompt),
                    timeoutHandler
                ]);

                await client.end();
                return { statusCode: 200, body: JSON.stringify({ success: true, respuesta: result.response.text() }) };

            } catch (error) {
                await client.end();
                if (error.message === "TIMEOUT_IA") {
                    const msgElegante = "⚠️ **Aviso del Sistema:** El documento analizado es muy extenso y mi tiempo de lectura se agotó. Por favor, hazme una pregunta más específica sobre el PDF.";
                    return { statusCode: 200, body: JSON.stringify({ success: true, respuesta: msgElegante }) };
                }
                return { statusCode: 500, body: JSON.stringify({ error: `Error IA: ${error.message}` }) };
            }
        }

        // ======================================================================
        // FUNCIÓN 3A: ANÁLISIS DE ACUERDO EXPRESS (SOLO LEE, NO GUARDA)
        // ======================================================================
        else if (accion === 'analizar_acuerdo_express') {
            const { modo, texto, pdf_base64, drive_link } = payload;
            let pdfBase64Final = pdf_base64;

            const usrRes = await client.query('SELECT id_firma, google_access_token, google_refresh_token FROM usuarios_sistema WHERE username = $1', [username]);
            const usr = usrRes.rows[0];

            if (modo === 'drive_link') {
                if (!usr.google_access_token) throw new Error("Debes conectar tu Google Drive en el banner superior.");
                const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
                oauth2Client.setCredentials({ access_token: usr.google_access_token, refresh_token: usr.google_refresh_token });
                const drive = google.drive({ version: 'v3', auth: oauth2Client });

                const match = drive_link.match(/\/d\/(.+?)\//) || drive_link.match(/id=(.+?)(&|$)/);
                if (!match) throw new Error("Enlace de Google Drive no válido.");
                try {
                    const driveRes = await drive.files.get({ fileId: match[1], alt: 'media' }, { responseType: 'arraybuffer' });
                    pdfBase64Final = Buffer.from(driveRes.data).toString('base64');
                } catch (e) { throw new Error("No se pudo leer el archivo de Drive. Asegúrate de tener permisos."); }
            }

            const todosExp = await client.query('SELECT id_expediente, numero_expediente, organo_jurisdiccional, cliente FROM expedientes WHERE id_firma = $1 AND estado_archivo = $2', [usr.id_firma, 'activo']);
            const catalogoExp = todosExp.rows.map(e => `ID:${e.id_expediente} | EXP:${e.numero_expediente} | JUZGADO:${e.organo_jurisdiccional} | CLIENTE:${e.cliente}`).join('\n');

            let contenidoPrompt = [];
            if (modo === 'pdf' || modo === 'drive_link') {
                contenidoPrompt.push({ inlineData: { data: pdfBase64Final, mimeType: "application/pdf" } });
                contenidoPrompt.push("Lee este documento judicial. ");
            } else {
                contenidoPrompt.push(`Analiza este texto: "${texto}". `);
            }

            contenidoPrompt.push(`
                Busca a qué expediente de esta lista pertenece el documento:
                ${catalogoExp}

                Devuelve UNICAMENTE un JSON con esta estructura exacta:
                {
                  "encontrado": true o false,
                  "id_expediente": "El ID numérico si lo encontraste (o null)",
                  "numero_visual": "El numero del expediente si lo encontraste (o null)",
                  "tipo_resolucion": "Auto, Sentencia, Interlocutoria o Decreto",
                  "fecha_dictada": "YYYY-MM-DD",
                  "resumen_detallado": "Un análisis exhaustivo de al menos 2 párrafos de lo que trata la resolución",
                  "sentido_corto": "Resumen de 3 a 5 palabras",
                  "comentario_corto": "Resumen de 4 líneas",
                  "nuevo_asunto": {
                     "numero": "Si no fue encontrado, extrae el número del expediente",
                     "juzgado": "Extrae el juzgado/tribunal completo",
                     "materia": "Amparo, Civil, Mercantil, Penal, etc.",
                     "via": "Indirecto, Ordinario, Ejecutivo, etc.",
                     "posible_cliente": "Extrae el nombre del actor o quejoso principal"
                  }
                }
            `);

            // Usamos la cascada global
            const result = await llamarIA(contenidoPrompt);
            let respuestaIA = result.response.text();

            const inicioJson = respuestaIA.indexOf('{');
            const finJson = respuestaIA.lastIndexOf('}') + 1;

            if (inicioJson !== -1 && finJson !== -1) {
                respuestaIA = respuestaIA.substring(inicioJson, finJson);
            } else {
                throw new Error("La IA no devolvió un formato válido. Intenta de nuevo.");
            }

            const datosIA = JSON.parse(respuestaIA);

            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true, datos_ia: datosIA }) };
        }

        // ======================================================================
        // FUNCIÓN 3B: EJECUCIÓN DEL ACUERDO EXPRESS (GUARDA EN BD Y DRIVE)
        // ======================================================================
        else if (accion === 'ejecutar_acuerdo_express') {
            const { payload: dataPayload, datos_ia, es_nuevo } = payload;
            let idFinalExpediente = datos_ia.id_expediente;
            let guardadoEnDrive = false;

            const usrRes = await client.query('SELECT id_firma, google_access_token, google_refresh_token FROM usuarios_sistema WHERE username = $1', [username]);
            const usr = usrRes.rows[0];

            if (es_nuevo) {
                const nav = datos_ia.nuevo_asunto;
                const insertExp = await client.query(`
                    INSERT INTO expedientes (id_firma, username, numero_expediente, organo_jurisdiccional, materia, via_procedimiento, cliente, abogado_asignado, color_tag, estado_archivo)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '#0a2540', 'activo')
                    RETURNING id_expediente
                `, [usr.id_firma, username, nav.numero, nav.juzgado, nav.materia, nav.via, nav.cliente, username]);
                idFinalExpediente = insertExp.rows[0].id_expediente;
            }

            const [y, m, d] = datos_ia.fecha_dictada.split('-');
            let fPub = new Date(y, m - 1, d);
            fPub.setDate(fPub.getDate() + 1);
            if (fPub.getDay() === 6) fPub.setDate(fPub.getDate() + 2);
            else if (fPub.getDay() === 0) fPub.setDate(fPub.getDate() + 1);
            const fPubStr = `'${fPub.getFullYear()}-${String(fPub.getMonth() + 1).padStart(2, '0')}-${String(fPub.getDate()).padStart(2, '0')}'`;

            await client.query(`
                INSERT INTO resoluciones_expediente (id_expediente, tipo, fecha_resolucion, fecha_publicacion, comentario, tipo_notificacion, creado_por) 
                VALUES ($1, $2, $3, ${fPubStr}, $4, 'Lista/Boletin', 'Vigilex IA (Express)')
            `, [idFinalExpediente, datos_ia.tipo_resolucion, datos_ia.fecha_dictada, datos_ia.comentario_final_usuario]);

            if (dataPayload.modo === 'pdf' && usr.google_access_token && !es_nuevo) {
                const fData = await client.query('SELECT drive_folder_id FROM expedientes WHERE id_expediente = $1', [idFinalExpediente]);
                if (fData.rows[0] && fData.rows[0].drive_folder_id) {
                    const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
                    oauth2Client.setCredentials({ access_token: usr.google_access_token, refresh_token: usr.google_refresh_token });
                    const drive = google.drive({ version: 'v3', auth: oauth2Client });

                    const bufferStream = new stream.PassThrough();
                    bufferStream.end(Buffer.from(dataPayload.pdf_base64, 'base64'));
                    const nombreFinal = dataPayload.nombre_archivo || `Acuerdo_${datos_ia.fecha_dictada}.pdf`;

                    await drive.files.create({
                        requestBody: { name: nombreFinal, parents: [fData.rows[0].drive_folder_id] },
                        media: { mimeType: 'application/pdf', body: bufferStream }
                    });
                    guardadoEnDrive = true;
                }
            }

            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true, guardado_en_drive: guardadoEnDrive }) };
        }

        // ======================================================================
        // FUNCIÓN 4: CHAT LIBRE (CON SUPERPODERES MULTIMODALES Y DRIVE)
        // ======================================================================
        else if (accion === 'chat_libre') {
            const { pregunta } = payload;

            const usrRes = await client.query('SELECT id_firma, google_access_token, google_refresh_token FROM usuarios_sistema WHERE username = $1', [username]);
            const usr = usrRes.rows[0];
            const idFirma = usr.id_firma;

            const resumenFirma = await client.query(`
                SELECT e.numero_expediente, e.cliente, e.materia, e.denominacion,
                (SELECT comentario FROM resoluciones_expediente WHERE id_expediente = e.id_expediente ORDER BY fecha_resolucion DESC LIMIT 1) as ultimo_acuerdo
                FROM expedientes e WHERE e.id_firma = $1 AND e.estado_archivo = 'activo'
            `, [idFirma]);

            const contextoGlobal = resumenFirma.rows.map(r => `- Exp ${r.numero_expediente} (${r.cliente}): ${r.denominacion || r.materia}. Último hito: ${r.ultimo_acuerdo || 'Sin acuerdos'}`).join('\n');

            let contenidoPrompt = [];
            let textoPregunta = pregunta;

            const matchFile = pregunta.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || pregunta.match(/id=([a-zA-Z0-9_-]+)/);
            const matchFolder = pregunta.match(/\/folders\/([a-zA-Z0-9_-]+)/);

            if ((matchFile || matchFolder) && usr.google_access_token) {
                try {
                    const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
                    oauth2Client.setCredentials({ access_token: usr.google_access_token, refresh_token: usr.google_refresh_token });
                    const drive = google.drive({ version: 'v3', auth: oauth2Client });

                    if (matchFile) {
                        const fileId = matchFile[1];
                        const driveRes = await drive.files.get({ fileId: fileId, alt: 'media' }, { responseType: 'arraybuffer' });
                        const pdfBase64 = Buffer.from(driveRes.data).toString('base64');

                        contenidoPrompt.push({ inlineData: { data: pdfBase64, mimeType: "application/pdf" } });
                        textoPregunta += "\n\n[Nota Interna: He descargado y adjuntado el documento PDF de Drive con éxito. Analízalo para responder al abogado.]";
                    }
                    else if (matchFolder) {
                        const folderId = matchFolder[1];
                        const resArchivos = await drive.files.list({
                            q: `'${folderId}' in parents`,
                            fields: 'files(name, createdTime)',
                            pageSize: 100
                        });

                        const listaArchivos = resArchivos.data.files.map(f => `- ${f.name}`).join('\n');
                        textoPregunta += `\n\n[Nota Interna: El abogado pegó un link de CARPETA. Índice de archivos:\n${listaArchivos}\nRecomienda usar IMPORTACIÓN MASIVA si quiere procesar todo.]`;
                    }
                } catch (error) {
                    textoPregunta += "\n\n[Nota Interna: Hubo un error al intentar acceder al link de Drive.]";
                }
            }

            // ======================================================================
            // BIBLIOTECA UNIVERSAL VIGILEX (INYECCIÓN PARA CHAT GENERAL)
            // ======================================================================
            const masterRes = await client.query(`
                SELECT google_access_token, google_refresh_token 
                FROM usuarios_sistema 
                WHERE username = 'adminvigilex' 
                AND google_access_token IS NOT NULL 
                LIMIT 1
            `);

            const masterToken = masterRes.rows[0];

            // Las mismas leyes que configuraste arriba
            const LEYES_GENERALES = ['1D0ZXOkREK5vB4G3XjufnGZu2qyJzGT5F']; //Constitución Política de los Estados Unidos Mexicanos
            const LEYES_FEDERALES = {
                'Mercantil': ['1ZXWMA4Wq8jTBrl11bcYKivPq5K3Eaf8d', 'ID_JURIS_MERCANTIL_FED'],
                'Fiscal': ['1dk2ateeOnEPWXt8p2rlmjtURkNAEYxWX'],
                'Penal': ['1X6Koq2pIf-vDYa3O32gQPBcZI2goWU1d', '1y5bVOvDGGEAuLYTWk1P7CPDOP2sRfIWI'],
                'Juicio de Amparo': ['1aIm5-LiK_t_KWWpuL1vPoNGWLDtHlxAV', '1EqqkEVo2FTJ7dKHIdC2A1Hwr76KaXi_J'],
                'Civil_Federal': ['1MOnv0jAk0zpj31-VvL9b829ID1k0tyFu', '1EqqkEVo2FTJ7dKHIdC2A1Hwr76KaXi_J', '1Lwv1i-uoAKjPWYDsMsDC2PWhQaZ9R_oJ']
            };
            const LEYES_JALISCO = {
                'Civil': ['1A0tWf6XVuk_GUeqOoslg2e09pHrapFcx', '1hmV1ENaJgq2-yTJsGYYPX_3uuI6057RJ'],
                'Familiar': ['1A0tWf6XVuk_GUeqOoslg2e09pHrapFcx', '1hmV1ENaJgq2-yTJsGYYPX_3uuI6057RJ', 'ID_JURIS_FAMILIAR_JALISCO']
            };

            if (masterToken) {
                try {
                    const oauthVigilex = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
                    oauthVigilex.setCredentials({ access_token: masterToken.google_access_token, refresh_token: masterToken.google_refresh_token });
                    const driveVigilex = google.drive({ version: 'v3', auth: oauthVigilex });

                    // ======================================================================
                    // 1. CARGA INTELIGENTE: Filtramos qué leyes descargar según la pregunta
                    // ======================================================================
                    let archivosFiltrados = [...LEYES_GENERALES]; // La Constitución siempre se carga
                    const preguntaMinuscula = textoPregunta.toLowerCase();

                    // Detectores de materia
                    if (preguntaMinuscula.includes('comercio') || preguntaMinuscula.includes('mercantil')) {
                        archivosFiltrados.push(...(LEYES_FEDERALES['Mercantil'] || []));
                    }
                    if (preguntaMinuscula.includes('civil')) {
                        archivosFiltrados.push(...(LEYES_JALISCO['Civil'] || []));
                        archivosFiltrados.push(...(LEYES_FEDERALES['Civil_Federal'] || []));
                    }
                    if (preguntaMinuscula.includes('amparo')) {
                        archivosFiltrados.push(...(LEYES_FEDERALES['Juicio de Amparo'] || []));
                    }
                    if (preguntaMinuscula.includes('familiar') || preguntaMinuscula.includes('divorcio') || preguntaMinuscula.includes('alimentos')) {
                        archivosFiltrados.push(...(LEYES_JALISCO['Familiar'] || []));
                    }
                    if (preguntaMinuscula.includes('penal') || preguntaMinuscula.includes('delito')) {
                        archivosFiltrados.push(...(LEYES_FEDERALES['Penal'] || []));
                    }
                    if (preguntaMinuscula.includes('fiscal') || preguntaMinuscula.includes('impuesto')) {
                        archivosFiltrados.push(...(LEYES_FEDERALES['Fiscal'] || []));
                    }

                    // 2. FILTRAMOS (Quitamos duplicados y placeholders como 'ID_...')
                    const archivosUnicos = [...new Set(archivosFiltrados)].filter(id => id && id.length > 15 && !id.startsWith('ID_'));

                    // 3. DESCARGA SIMULTÁNEA RÁPIDA (Optimizada para archivos .TXT)
                    const promesasDescarga = archivosUnicos.map(async (fileIdLey) => {
                        try {
                            const driveResLey = await driveVigilex.files.get({ fileId: fileIdLey, alt: 'media' }, { responseType: 'arraybuffer' });
                            // Convertimos a texto puro (utf-8)
                            return Buffer.from(driveResLey.data).toString('utf-8').substring(0, 2500000);
                        } catch (e) {
                            console.warn("No se pudo descargar el ID:", fileIdLey);
                            return null;
                        }
                    });

                    const resultadosLeyesTXT = await Promise.all(promesasDescarga);

                    // 4. INYECTAMOS LOS CÓDIGOS COMO TEXTO PURO A LA IA
                    resultadosLeyesTXT.forEach((textoLey, index) => {
                        if (textoLey) {
                            contenidoPrompt.push(`\n--- LEGISLACIÓN OFICIAL #${index + 1} ---\n${textoLey}\n-----------------------\n`);
                        }
                    });

                    textoPregunta += `\n\n[SISTEMA VIGILEX: Se ha adjuntado la Biblioteca Central en texto puro. Es OBLIGATORIO que bases tus respuestas ÚNICA Y EXCLUSIVAMENTE en estos documentos oficiales. No uses conocimientos externos. Si te piden citar un artículo, transcríbelo textualmente.]`;
                } catch (errorLey) {
                    console.warn("⚠️ Biblioteca Central inaccesible en chat libre:", errorLey.message);
                }
            }
            // ======================================================================

            contenidoPrompt.push(`
                Eres "Vigilex AI", el cerebro central y estratega legal de una firma de abogados de élite.
                
                --- CONTEXTO DE EXPEDIENTES ---
                ${contextoGlobal}
                ---------------------------------------------

                El abogado dice: "${textoPregunta}"
                
                Instrucciones Generales:
                1. Cruza la información con el contexto provisto.
                2. Si adjuntó un documento, analízalo a fondo.
                3. Sé ejecutivo, directo y estratégico.
                4. Usa formato Markdown. No saludes, ve directo a la respuesta.
            `);

            try {
                const timeoutHandler = new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT_IA")), 25000));

                // Usamos la cascada global contra el reloj
                const result = await Promise.race([
                    llamarIA(contenidoPrompt),
                    timeoutHandler
                ]);

                await client.end();
                return { statusCode: 200, body: JSON.stringify({ success: true, respuesta: result.response.text() }) };

            } catch (error) {
                await client.end();
                if (error.message === "TIMEOUT_IA") {
                    const msgElegante = "⚠️ **Aviso del Sistema:** El documento enlazado es demasiado extenso para el chat en vivo. Usa el módulo de **Importación Masiva** o haz una pregunta más específica.";
                    return { statusCode: 200, body: JSON.stringify({ success: true, respuesta: msgElegante }) };
                }
                return { statusCode: 500, body: JSON.stringify({ error: `Error IA: ${error.message}` }) };
            }
        }

        // ======================================================================
        // FUNCIÓN 5A: IMPORTACIÓN MASIVA - FASE 1 (ESCANEAR Y CREAR)
        // ======================================================================
        else if (accion === 'masivo_fase1_escanear') {
            const { folder_link } = payload;

            const usrRes = await client.query('SELECT id_firma, google_access_token, google_refresh_token FROM usuarios_sistema WHERE username = $1', [username]);
            const usr = usrRes.rows[0];
            if (!usr.google_access_token) throw new Error("Debes conectar tu Google Drive primero.");

            const match = folder_link.match(/folders\/([a-zA-Z0-9_-]+)/);
            if (!match) throw new Error("Enlace de Drive no válido.");
            const folderId = match[1];

            const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
            oauth2Client.setCredentials({ access_token: usr.google_access_token, refresh_token: usr.google_refresh_token });
            const drive = google.drive({ version: 'v3', auth: oauth2Client });

            const resArchivos = await drive.files.list({
                q: `'${folderId}' in parents and mimeType='application/pdf'`,
                fields: 'files(id, name)',
                pageSize: 50
            });
            const archivos = resArchivos.data.files;
            if (!archivos || archivos.length === 0) throw new Error("No se encontraron PDFs en la carpeta.");

            const driveRes = await drive.files.get({ fileId: archivos[0].id, alt: 'media' }, { responseType: 'arraybuffer' });
            const pdfBase64 = Buffer.from(driveRes.data).toString('base64');

            // Usamos la cascada global
            const result = await llamarIA([
                { inlineData: { data: pdfBase64, mimeType: "application/pdf" } },
                `Lee este documento judicial. Extrae los datos generales del expediente y devuelve ÚNICAMENTE un JSON con esta estructura exacta:
                {
                     "numero": "Ej. 1511/2023",
                     "juzgado": "Nombre completo del juzgado/tribunal",
                     "materia": "Amparo, Civil, Mercantil, Penal, etc.",
                     "via": "Indirecto, Ordinario, Ejecutivo, etc.",
                     "cliente": "Nombre de la parte a la que defendemos o actor principal"
                }`
            ]);

            let respuestaIA = result.response.text();
            respuestaIA = respuestaIA.substring(respuestaIA.indexOf('{'), respuestaIA.lastIndexOf('}') + 1);
            const datosCaso = JSON.parse(respuestaIA);

            const numExp = datosCaso.numero || 'S/N';
            const juzgado = datosCaso.juzgado || 'Desconocido';

            let idExpedienteCreado;

            const buscarExp = await client.query(`
                SELECT id_expediente FROM expedientes 
                WHERE id_firma = $1 AND numero_expediente = $2
            `, [usr.id_firma, numExp]);

            if (buscarExp.rows.length > 0) {
                idExpedienteCreado = buscarExp.rows[0].id_expediente;
                await client.query(`
                    UPDATE expedientes SET drive_folder_id = $1 
                    WHERE id_expediente = $2 AND (drive_folder_id IS NULL OR drive_folder_id = '')
                `, [folderId, idExpedienteCreado]);

            } else {
                const insertExp = await client.query(`
                    INSERT INTO expedientes (id_firma, username, numero_expediente, organo_jurisdiccional, materia, via_procedimiento, cliente, abogado_asignado, color_tag, estado_archivo, drive_folder_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '#1565c0', 'activo', $9)
                    RETURNING id_expediente
                `, [usr.id_firma, username, numExp, juzgado, datosCaso.materia || '', datosCaso.via || '', datosCaso.cliente || 'Desconocido', username, folderId]);
                idExpedienteCreado = insertExp.rows[0].id_expediente;
            }

            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true, id_expediente: idExpedienteCreado, numero_visual: numExp, archivos: archivos }) };
        }

        // ======================================================================
        // FUNCIÓN 5B: IMPORTACIÓN MASIVA - FASE 2 (PROCESAR RESOLUCIONES)
        // ======================================================================
        else if (accion === 'masivo_fase2_procesar') {
            const { id_expediente, cuaderno, file_id, file_name } = payload;

            const usrRes = await client.query('SELECT google_access_token, google_refresh_token FROM usuarios_sistema WHERE username = $1', [username]);
            const usr = usrRes.rows[0];

            const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
            oauth2Client.setCredentials({ access_token: usr.google_access_token, refresh_token: usr.google_refresh_token });
            const drive = google.drive({ version: 'v3', auth: oauth2Client });

            const driveRes = await drive.files.get({ fileId: file_id, alt: 'media' }, { responseType: 'arraybuffer' });
            const pdfBase64 = Buffer.from(driveRes.data).toString('base64');

            const contenidoPrompt = [
                { inlineData: { data: pdfBase64, mimeType: "application/pdf" } },
                `Lee este documento. Haz una síntesis de la resolución y devuelve UNICAMENTE un JSON con esta estructura exacta:
                {
                  "tipo": "Auto, Sentencia, Interlocutoria o Decreto",
                  "fecha_dictada": "YYYY-MM-DD",
                  "sentido": "Resumen de 3 a 5 palabras",
                  "comentario": "Resumen ejecutivo de máximo 4 líneas"
                }`
            ];

            // Usamos la cascada global
            const result = await llamarIA(contenidoPrompt);

            let respuestaIA = result.response.text();
            respuestaIA = respuestaIA.substring(respuestaIA.indexOf('{'), respuestaIA.lastIndexOf('}') + 1);
            const d = JSON.parse(respuestaIA);

            let fPubStr = 'CURRENT_DATE';
            if (d.fecha_dictada && d.fecha_dictada !== 'null') {
                const [y, m, day] = d.fecha_dictada.split('-');
                let fPub = new Date(y, m - 1, day);
                fPub.setDate(fPub.getDate() + 1);
                if (fPub.getDay() === 6) fPub.setDate(fPub.getDate() + 2);
                else if (fPub.getDay() === 0) fPub.setDate(fPub.getDate() + 1);
                fPubStr = `'${fPub.getFullYear()}-${String(fPub.getMonth() + 1).padStart(2, '0')}-${String(fPub.getDate()).padStart(2, '0')}'`;
            }

            await client.query(`
                INSERT INTO resoluciones_expediente (id_expediente, tipo, fecha_resolucion, fecha_publicacion, comentario, cuaderno, tipo_notificacion, creado_por) 
                VALUES ($1, $2, $3, ${fPubStr}, $4, $5, 'Lista/Boletin', 'Vigilex AI 3 (Masivo)')
            `, [id_expediente, d.tipo || 'Auto', d.fecha_dictada || null, `🎯 ${d.sentido || 'Resolución Procesada'}\n\n${d.comentario || 'Ver documento en Drive.'}`, cuaderno || 'Principal']);

            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true, tipo: d.tipo, fecha: d.fecha_dictada, sentido: d.sentido }) };
        }

        // ======================================================================
        // FUNCIÓN: MASIVO EXISTENTE - FASE 1 (SOLO LISTAR ARCHIVOS)
        // ======================================================================
        else if (accion === 'masivo_existente_fase1') {
            const { folder_link } = payload;

            const usrRes = await client.query('SELECT google_access_token, google_refresh_token FROM usuarios_sistema WHERE username = $1', [username]);
            const usr = usrRes.rows[0];
            if (!usr.google_access_token) throw new Error("Debes conectar tu Google Drive primero.");

            const match = folder_link.match(/folders\/([a-zA-Z0-9_-]+)/);
            if (!match) throw new Error("El enlace no parece ser una carpeta de Drive válida.");
            const folderId = match[1];

            const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
            oauth2Client.setCredentials({ access_token: usr.google_access_token, refresh_token: usr.google_refresh_token });
            const drive = google.drive({ version: 'v3', auth: oauth2Client });

            const resArchivos = await drive.files.list({
                q: `'${folderId}' in parents and mimeType='application/pdf'`,
                fields: 'files(id, name)',
                pageSize: 40
            });

            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true, archivos: resArchivos.data.files || [] }) };
        }

        // ======================================================================
        // VERIFICAR ESTADO DE CONEXIÓN DE LA FIRMA (ÚNICA)
        // ======================================================================
        else if (accion === 'verificar_drive') {
            // 1. Obtenemos el id_firma del usuario que consulta
            const userRes = await client.query('SELECT id_firma FROM usuarios_sistema WHERE username = $1', [username]);
            const idFirma = userRes.rows[0].id_firma;

            // 2. Buscamos si ALGUIEN en esa firma tiene Google Drive conectado (el Titular)
            const firmaRes = await client.query(`
                SELECT google_access_token, google_email, username as dueño_token, rol_equipo 
                FROM usuarios_sistema 
                WHERE id_firma = $1 AND google_access_token IS NOT NULL 
                ORDER BY (CASE WHEN rol_equipo = 'titular' THEN 1 WHEN rol_equipo = 'master' THEN 2 ELSE 3 END) ASC 
                LIMIT 1
            `, [idFirma]);

            const d = firmaRes.rows[0];
            const conectado = !!d;

            await client.end();
            return {
                statusCode: 200,
                body: JSON.stringify({
                    success: true,
                    conectado: conectado,
                    email: d ? d.google_email : null,
                    es_dueño: d ? (d.dueño_token === username) : false // Para saber si el que consulta puede desconectarlo
                })
            };
        }

        // ======================================================================
        // DESCONECTAR DRIVE DE TODA LA FIRMA (SOLO TITULAR/MASTER)
        // ======================================================================
        else if (accion === 'desconectar_drive') {
            const userRes = await client.query('SELECT id_firma, rol_equipo FROM usuarios_sistema WHERE username = $1', [username]);
            const { id_firma, rol_equipo } = userRes.rows[0];

            // Bloqueo de seguridad: Solo Titular o Master pueden desconectar la cuenta del despacho
            if (rol_equipo !== 'titular' && rol_equipo !== 'master') {
                throw new Error("No tienes permisos de administrador para desconectar el Drive del despacho.");
            }

            await client.query(`
                UPDATE usuarios_sistema 
                SET google_access_token = NULL, google_refresh_token = NULL, google_email = NULL 
                WHERE id_firma = $1
            `, [id_firma]);

            await client.end();
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        await client.end();
        return { statusCode: 400, body: JSON.stringify({ error: 'Acción de IA no reconocida' }) };


    } catch (error) {
        if (client) await client.end();
        console.error("Error en AI Core:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};