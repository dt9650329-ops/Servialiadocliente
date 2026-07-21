const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

async function enviarPush(uid, title, body, data = {}) {
  const tokenSnap = await admin.database().ref(`usuarios/${uid}/fcmToken`).get();
  if (!tokenSnap.exists()) return;
  const token = tokenSnap.val();
  const tonoSnap = await admin.database().ref(`usuarios/${uid}/tonoNotificacion`).get();
  const tono = tonoSnap.exists() ? tonoSnap.val() : '1';
  const message = {
    token,
    notification: { title, body },
    data,
    android: {
      priority: 'high',
      notification: { channelId: 'pedidos_tono' + tono }
    }
  };
  try {
    await admin.messaging().send(message);
  } catch (e) {
    console.error('Error enviando push a', uid, e);
    if (e.code === 'messaging/registration-token-not-registered') {
      await admin.database().ref(`usuarios/${uid}/fcmToken`).remove();
    }
  }
}

function obtenerClienteUID(pedido) {
  return pedido.clienteUID || pedido.clienteId || pedido.clienteIdAsignado;
}

function obtenerRepartidorUID(pedido) {
  return pedido.repartidorIdAsignado || pedido.repartidorUID || pedido.repartidorId;
}

function _uidBase(path) {
  return String(path || '').replace(/^(cliente_auth_)+/, '');
}

exports.onNuevoMensajeChat = functions.database
  .ref('/chat_p2p/{pedidoId}/{msgId}')
  .onCreate(async (snap, context) => {
    const m = snap.val();
    if (!m) return null;

    const pedidoId = context.params.pedidoId;
    const pedidoSnap = await admin.database().ref(`pedidos_historial/${pedidoId}`).get();
    if (!pedidoSnap.exists()) return null;
    const pedido = pedidoSnap.val();

    const texto = m.texto || (m.tipo === 'imagen' ? 'Imagen' : m.tipo === 'audio' ? 'Audio' : '');

    if (m.remitente === 'repartidor') {
      const clienteUID = obtenerClienteUID(pedido);
      if (!clienteUID) return null;
      const rep = m.repartidorNombre || 'Tu repartidor';
      await enviarPush(
        clienteUID,
        'Mensaje de ' + rep,
        rep + ' te escribió' + (texto ? ': "' + texto + '"' : ''),
        { pedidoId, tipo: 'chat_p2p' }
      );
    } else if (m.remitente === 'cliente') {
      const repartidorUID = obtenerRepartidorUID(pedido);
      if (!repartidorUID) return null;
      const cli = m.clienteNombre || 'Tu cliente';
      await enviarPush(
        repartidorUID,
        'Mensaje de ' + cli,
        cli + ' te escribió' + (texto ? ': "' + texto + '"' : ''),
        { pedidoId, tipo: 'chat_p2p' }
      );
    }
    return null;
  });

exports.onCambioEstadoPedido = functions.database
  .ref('/pedidos_historial/{pedidoId}/estado')
  .onUpdate(async (change, context) => {
    const nuevoEstado = (change.after.val() || '').toLowerCase();
    const pedidoId = context.params.pedidoId;
    const pedidoSnap = await admin.database().ref(`pedidos_historial/${pedidoId}`).get();
    if (!pedidoSnap.exists()) return null;
    const pedido = pedidoSnap.val();
    const clienteUID = obtenerClienteUID(pedido);
    if (!clienteUID) return null;

    const labels = {
      'aceptado': 'Tu pedido fue aceptado',
      'esperando': 'Repartidor en punto de recogida',
      'en camino': '¡Tu pedido va en camino!',
      'completado': '¡Pedido entregado!',
      'entregado': '¡Pedido entregado!',
      'cancelado': 'Pedido cancelado'
    };
    const titulo = labels[nuevoEstado] || 'Estado actualizado';
    const rep = pedido.repartidorNombre || '';
    const cuerpo = rep ? 'Tu repartidor ' + rep + ': ' + nuevoEstado : 'Estado: ' + nuevoEstado;

    await enviarPush(clienteUID, titulo, cuerpo, { pedidoId, tipo: 'estado_pedido' });
    return null;
  });

exports.onNuevaNotificacionUsuario = functions.database
  .ref('/notificaciones_usuario/{path}/{notifId}')
  .onCreate(async (snap, context) => {
    const n = snap.val();
    if (!n) return null;
    const uid = _uidBase(context.params.path);
    if (!uid) return null;

    await enviarPush(
      uid,
      n.titulo || 'Notificación',
      n.mensaje || n.texto || '',
      { tipo: 'notificacion_usuario' }
    );
    return null;
  });

exports.onNuevaNotificacionGlobal = functions.database
  .ref('/notificaciones_globales/{notifId}')
  .onCreate(async (snap, context) => {
    const n = snap.val();
    if (!n) return null;

    const usersSnap = await admin.database().ref('usuarios').get();
    if (!usersSnap.exists()) return null;

    const tokens = [];
    usersSnap.forEach(function(child) {
      const t = child.val() && child.val().fcmToken;
      if (t) tokens.push(t);
    });
    if (tokens.length === 0) {
      console.log('[global] no hay usuarios con fcmToken guardado');
      return null;
    }

    const titulo = n.titulo || 'Aviso de Servi Aliados';
    const mensaje = n.mensaje || n.texto || '';

    const tandas = [];
    for (let i = 0; i < tokens.length; i += 500) tandas.push(tokens.slice(i, i + 500));

    let enviados = 0, invalidos = 0;
    for (const tanda of tandas) {
      try {
        const resultado = await admin.messaging().sendEachForMulticast({
          tokens: tanda,
          notification: { title: titulo, body: mensaje },
          android: { priority: 'high' },
          data: { tipo: 'aviso_global' }
        });
        enviados += resultado.successCount;

        resultado.responses.forEach(function(r, idx) {
          if (!r.success && r.error && r.error.code === 'messaging/registration-token-not-registered') {
            invalidos++;
          }
        });
      } catch (e) {
        console.error('[global] error enviando tanda:', e);
      }
    }
    console.log('[global] aviso enviado a', enviados, 'usuarios de', tokens.length, '(', invalidos, 'tokens invalidos)');
    return null;
  });

// ======================================================================
// SERVIBOT — Chatbot con Gemini AI (function calling)
// ======================================================================
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');

const herramientas = [
  {
    functionDeclarations: [
      {
        name: 'consultarEstadoPedido',
        description: 'Consulta el estado actual del pedido activo de un cliente (en camino, pendiente, entregado, etc.) y datos del repartidor asignado.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    ],
  },
];

async function consultarEstadoPedido(clienteEmail) {
  const snap = await admin.database()
    .ref('pedidos_historial')
    .orderByChild('clienteEmail')
    .equalTo(clienteEmail)
    .limitToLast(5)
    .once('value');

  if (!snap.exists()) {
    return { encontrado: false, mensaje: 'No se encontró ningún pedido reciente para este cliente.' };
  }

  const pedidos = Object.entries(snap.val())
    .map(([id, p]) => ({ id, ...p }))
    .filter(p => !['entregado', 'cancelado'].includes(p.estado))
    .sort((a, b) => (b.timestampCreacion || 0) - (a.timestampCreacion || 0));

  if (pedidos.length === 0) {
    return { encontrado: false, mensaje: 'No tienes pedidos activos en este momento.' };
  }

  const p = pedidos[0];
  return {
    encontrado: true,
    estado: p.estado,
    repartidor: p.repartidorNombre || 'Sin asignar',
    descripcion: p.descripcion || '',
    montoTotal: p.montoTotal || 0,
    tiempoEstimadoEntrega: p.tiempoEstimadoEntrega || null,
  };
}

function buildSystemPrompt(logueado, clienteEmail) {
  const ahora = new Date();
  const fecha = ahora.toLocaleDateString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'full' });
  const hora = ahora.toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' });

  return `Eres el asistente virtual de "Servi Aliados", servicio de domicilios en Armenia, Colombia.
Tu nombre es ServiBot. Eres amable, claro y útil. Responde siempre en español colombiano.
Fecha y hora actual: ${fecha}, ${hora}.
${logueado ? `Cliente autenticado (correo: ${clienteEmail}).` : 'El cliente NO ha iniciado sesión.'}

— TARIFAS DENTRO DE ARMENIA (por distancia real de ruta) —
• Hasta 1 km: $4.000
• Hasta 3.1 km: $5.000
• Hasta 5.9 km: $6.000
• Hasta 7.5 km: $7.000
• Hasta 9 km: $8.000
• Hasta 10.5 km: $9.000
• Más de 10.5 km: $10.000
• Extra paquete grande (caja/bolsa voluminosa): +$1.000
• Extra paquete muy grande (mueble, electrodoméstico): +$2.000

ZONAS EN ARMENIA: Sur, Centro, Norte, Oriente, Occidente

— DESTINOS FUERA DE ARMENIA —
Calarcá, Circasia, Montenegro, La Tebaida, Puerto Tapao, Salento,
Quimbaya, Filandia, Buenavista, Pijao, Génova, Córdoba y vías principales.
Tarifa fuera de Armenia: cuota mínima $5.000 + $1.000 por kilómetro recorrido.
Ejemplo: 4 km = $5.000 base + $4.000 km = $9.000 total.
El administrador confirma el valor exacto según la dirección.

— HORARIO DE ATENCIÓN —
Servicio disponible de 8:00 AM a 11:00 PM todos los días.
Fuera de ese horario no hay repartidores disponibles.

— QUEJAS Y SOPORTE URGENTE —
Existe un número directo del encargado para quejas graves o reclamos importantes.
SOLO comparte ese número si el cliente lo pide explícitamente para una queja o reclamo.
NO lo menciones proactivamente ni en respuestas generales.
Si el cliente pregunta por el número de quejas o reclamos graves, entonces sí proporciona:
WhatsApp del encargado: 3137065977

— TIEMPOS ESTIMADOS —
• Recogida: 5–25 min según distancia y pedidos en cola del repartidor
• Entrega total: 15–45 min

— CÓMO HACER UN PEDIDO —
1. Inicia sesión o regístrate
2. Ve a la pestaña "Servicio"
3. Completa el formulario: Punto A (quién entrega) y Punto B (quién recibe)
4. Selecciona zonas → el precio aparece automáticamente
5. Elige el tamaño del paquete si aplica
6. Confirma y envía

— SEGUIMIENTO DEL PEDIDO —
En la pestaña "Seguir" el cliente ingresa su correo para ver:
- Estado actual: Pendiente → Aceptado → Esperando → En Camino → Completado
- Ubicación del repartidor en tiempo real en el mapa
Si el cliente está autenticado y pregunta por su pedido, usa la herramienta
consultarEstadoPedido en vez de mandarlo a la pestaña "Seguir".

— SISTEMA DE NIVELES DE EXPERIENCIA —
Nivel 1 · Cliente Nuevo (0-50 dom): 1 giro de ruleta + cupón $600 de descuento.
Nivel 2 · Cliente Nuevo (51-130 dom): 2 giros de ruleta + cupón $1.200 de descuento.
Nivel 3 · Cliente Estrella (131-220+ dom): 3 giros + cupón $6.000 de descuento.
Las recompensas se otorgan al alcanzar cada nivel. Los puntos nunca se pierden.

— REGLAS IMPORTANTES —
- NUNCA compartas datos de OTROS clientes (nombres, teléfonos, direcciones, estados de pedidos ajenos).
- Solo puedes hablar del pedido del cliente que está escribiendo.
- Si el cliente no está autenticado y pregunta por su pedido específico, pídele que inicie sesión.
- Si te preguntan algo que no sabes responder (peso máximo, políticas especiales, etc.), responde
  que no tienes esa información en este momento pero que puede escribir al chat de soporte para
  que le respondan de inmediato.
- Respuestas concisas: máximo 3–4 párrafos cortos. Usa emojis con moderación.
- Recuerda siempre el horario: servicio de 8 AM a 11 PM.
- Mantente siempre en temas de Servi Aliados (precios, zonas, tiempos, pedidos, cuenta, etc). Si
  te preguntan algo totalmente ajeno (chistes, tareas, trivia, clima), redirige amablemente al tema.`;
}

exports.servibotChat = onCall({ secrets: [GEMINI_API_KEY] }, async (request) => {
  const { mensaje, historial } = request.data;
  const clienteEmail = request.auth?.token?.email || null;
  const logueado = !!clienteEmail;

  if (!mensaje) {
    throw new HttpsError('invalid-argument', 'Falta el mensaje.');
  }

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY.value());
  const model = genAI.getGenerativeModel({
    model: 'gemini-3.1-flash-lite',
    tools: herramientas,
    systemInstruction: buildSystemPrompt(logueado, clienteEmail),
  });

  // Historial que manda el cliente: [{role:'user'|'model', content: '...'}, ...]
  // (últimos mensajes de la conversación, sin incluir el mensaje actual)
  const historialGemini = Array.isArray(historial)
    ? historial
        .filter(h => h && typeof h.content === 'string' && (h.role === 'user' || h.role === 'model'))
        .slice(-10)
        .map(h => ({ role: h.role, parts: [{ text: h.content }] }))
    : [];

  const chat = model.startChat({ history: historialGemini });
  const result = await chat.sendMessage(mensaje);
  const call = result.response.functionCalls()?.[0];

  if (call && call.name === 'consultarEstadoPedido') {
    const datosPedido = logueado
      ? await consultarEstadoPedido(clienteEmail)
      : { encontrado: false, mensaje: 'El cliente no ha iniciado sesión, no se puede consultar su pedido.' };
    const result2 = await chat.sendMessage([
      { functionResponse: { name: 'consultarEstadoPedido', response: datosPedido } },
    ]);
    return { respuesta: result2.response.text() };
  }

  return { respuesta: result.response.text() };
});
