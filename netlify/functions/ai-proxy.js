exports.handler = async function (event, context) {

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Método no permitido' }) };
    }

    const allowedOrigins = [
        'https://servialiadocliente.netlify.app',
        'https://ialiadocliente.netlify.app',
        'http://localhost:3000',
        'http://127.0.0.1:5500'
    ];
    const origin     = event.headers.origin || '';
    const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
    const corsHeaders = {
        'Access-Control-Allow-Origin' : corsOrigin,
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Content-Type'                : 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: corsHeaders, body: '' };
    }

    let body;
    try { body = JSON.parse(event.body); }
    catch {
        return { statusCode: 400, headers: corsHeaders,
                 body: JSON.stringify({ error: 'Body inválido' }) };
    }

    const { messages, system } = body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return { statusCode: 400, headers: corsHeaders,
                 body: JSON.stringify({ error: 'Se requiere messages' }) };
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return { statusCode: 500, headers: corsHeaders,
                 body: JSON.stringify({ error: 'GEMINI_API_KEY no configurada' }) };
    }

    const geminiContents = [];

    if (system) {
        geminiContents.push({ role: 'user',  parts: [{ text: '[INSTRUCCIONES]\n' + system }] });
        geminiContents.push({ role: 'model', parts: [{ text: 'Entendido, seguiré esas instrucciones.' }] });
    }

    for (const msg of messages.slice(-14)) {
        geminiContents.push({
            role : msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }]
        });
    }

    // ✅ Cambiado de gemini-2.0-flash a gemini-1.5-flash (más cuota gratuita)
    const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + apiKey;

    try {
        const response = await fetch(GEMINI_URL, {
            method : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body   : JSON.stringify({
                contents: geminiContents,
                generationConfig: {
                    temperature    : 0.7,
                    maxOutputTokens: 600,
                    topP           : 0.9
                }
            })
        });

        const data = await response.json();

        if (!response.ok) {
            return { statusCode: response.status, headers: corsHeaders,
                     body: JSON.stringify({ error: data.error?.message || 'Error Gemini' }) };
        }

        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No pude generar una respuesta.';

        return {
            statusCode: 200,
            headers   : corsHeaders,
            body      : JSON.stringify({ content: [{ type: 'text', text }] })
        };

    } catch (err) {
        return { statusCode: 502, headers: corsHeaders,
                 body: JSON.stringify({ error: 'No se pudo conectar con Gemini' }) };
    }
};
