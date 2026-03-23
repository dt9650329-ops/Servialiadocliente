// ══════════════════════════════════════════════════════════════
//  📁 netlify/functions/ai-proxy.js
//  Proxy seguro para la API de Anthropic (Claude)
//  La API key NUNCA se expone al cliente — vive solo aquí.
// ══════════════════════════════════════════════════════════════

exports.handler = async function (event, context) {

  // ── Solo aceptar POST ──────────────────────────────────────
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Método no permitido' })
    };
  }

  // ── CORS: permitir solicitudes desde tu dominio ────────────
  // Cambia esto por tu dominio real en producción,
  // ej: 'https://servialiadocliente.netlify.app'
  const allowedOrigins = [
    'https://servialiadocliente.netlify.app',
    'https://ialiadocliente.netlify.app',
    'http://localhost:3000',   // para pruebas locales
    'http://127.0.0.1:5500'   // Live Server de VS Code
  ];

  const origin = event.headers.origin || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  const corsHeaders = {
    'Access-Control-Allow-Origin' : corsOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type'                : 'application/json'
  };

  // ── Preflight OPTIONS ──────────────────────────────────────
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  // ── Leer y validar el body enviado desde el cliente ────────
  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Body inválido — se esperaba JSON' })
    };
  }

  const { messages, system, max_tokens } = body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Se requiere el campo "messages"' })
    };
  }

  // ── Límites de seguridad ───────────────────────────────────
  // Máximo 16 turnos de conversación para evitar abuso
  const messagesCapped = messages.slice(-16);

  // Máximo 800 tokens de respuesta (suficiente para el chatbot)
  const maxTok = Math.min(max_tokens || 600, 800);

  // ── API key desde variable de entorno de Netlify ───────────
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('❌ Variable ANTHROPIC_API_KEY no configurada');
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Configuración del servidor incompleta' })
    };
  }

  // ── Llamada a la API de Anthropic ─────────────────────────
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method : 'POST',
      headers: {
        'Content-Type'      : 'application/json',
        'x-api-key'         : apiKey,
        'anthropic-version' : '2023-06-01'
      },
      body: JSON.stringify({
        model     : 'claude-sonnet-4-20250514',
        max_tokens: maxTok,
        system    : system || '',
        messages  : messagesCapped
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('❌ Error de Anthropic API:', data);
      return {
        statusCode: response.status,
        headers   : corsHeaders,
        body      : JSON.stringify({ error: data.error?.message || 'Error en la API' })
      };
    }

    return {
      statusCode: 200,
      headers   : corsHeaders,
      body      : JSON.stringify(data)
    };

  } catch (err) {
    console.error('❌ Error de red al llamar Anthropic:', err);
    return {
      statusCode: 502,
      headers   : corsHeaders,
      body      : JSON.stringify({ error: 'No se pudo conectar con el servidor de IA' })
    };
  }
};
