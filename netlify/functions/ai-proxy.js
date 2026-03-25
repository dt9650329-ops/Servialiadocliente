exports.handler = async function (event, context) {
    const origin = event.headers.origin || '';
    const corsHeaders = {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers: corsHeaders, body: 'Solo POST' };

    let body;
    try {
        body = JSON.parse(event.body);
    } catch (e) {
        return { statusCode: 400, headers: corsHeaders, body: 'JSON invalido' };
    }

    const { messages, system } = body;
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) return { statusCode: 500, headers: corsHeaders, body: 'Falta GEMINI_API_KEY' };

    // Construir historial con alternancia estricta user <-> model
    // Fusionamos mensajes seguidos del mismo rol para que Gemini no se bloquee
    const geminiContents = [];
    if (messages && Array.isArray(messages)) {
        for (const msg of messages.slice(-14)) {
            const role = (msg.role === 'assistant' || msg.role === 'model') ? 'model' : 'user';
            const last = geminiContents[geminiContents.length - 1];

            if (last && last.role === role) {
                // Si el mensaje anterior es del mismo rol, los unimos
                last.parts[0].text += '\n' + (msg.content || msg.text || '');
            } else {
                geminiContents.push({ role, parts: [{ text: msg.content || msg.text || '' }] });
            }
        }
    }

    // Asegurar que el último mensaje sea 'user' (regla de Google AI)
    while (geminiContents.length > 0 && geminiContents[geminiContents.length - 1].role !== 'user') {
        geminiContents.pop();
    }

    const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    const payload = {
        contents: geminiContents,
        system_instruction: system ? { parts: [{ text: system }] } : undefined,
        generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 1000,
            topP: 0.95
        }
    };

    try {
        const response = await fetch(GEMINI_URL, {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        const data = await response.json();

        if (!response.ok) {
            console.error('❌ Gemini Error:', data.error);
            return { statusCode: response.status, headers: corsHeaders, body: JSON.stringify(data.error) };
        }

        const aiResponse = data.candidates?.[0]?.content?.parts?.[0]?.text || "No hay respuesta";

        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({ content: [{ text: aiResponse }] })
        };

    } catch (err) {
        console.error('❌ Proxy Exception:', err);
        return { statusCode: 502, headers: corsHeaders, body: 'Error de conexion' };
    }
};
