exports.handler = async function (event, context) {
    const origin = event.headers.origin || '';
    const corsHeaders = {
        'Access-Control-Allow-Origin': origin, // dinamico para pruebas locales
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: corsHeaders, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Solo se permiten peticiones POST' }) };
    }

    let body;
    try {
        body = JSON.parse(event.body);
    } catch (e) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Cuerpo de petición inválido' }) };
    }

    const { messages, system } = body;
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
        return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Configuración: GEMINI_API_KEY no encontrada en el entorno de Netlify' }) };
    }

    if (!messages || !Array.isArray(messages)) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'El campo "messages" es obligatorio y debe ser un array' }) };
    }

    // Convertimos roles y filtramos para asegurar alternancia
    let lastRole = null;
    const geminiContents = messages
        .slice(-16) // Tomamos los últimos 16 para mayor contexto
        .map(msg => ({
            role: (msg.role === 'assistant' || msg.role === 'model') ? 'model' : 'user',
            parts: [{ text: msg.content || msg.text || '' }]
        }))
        .filter(m => {
            // No permitir dos roles iguales seguidos (Fatal en Gemini)
            if (m.role === lastRole) return false;
            lastRole = m.role;
            return true;
        });

    const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    const payload = {
        contents: geminiContents,
        system_instruction: system ? {
            parts: [{ text: system }]
        } : undefined,
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
            return {
                statusCode: response.status,
                headers: corsHeaders,
                body: JSON.stringify({ error: data.error?.message || 'Error de Gemini API' })
            };
        }

        // Extraer texto generado
        const aiResponse = data.candidates?.[0]?.content?.parts?.[0]?.text || "No pude generar una respuesta en este momento.";

        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({
                content: [{ type: 'text', text: aiResponse }]
            })
        };

    } catch (err) {
        console.error('❌ Proxy Exception:', err);
        return {
            statusCode: 502,
            headers: corsHeaders,
            body: JSON.stringify({ error: 'Error de red al conectar con el servidor de IA: ' + err.message })
        };
    }
};
