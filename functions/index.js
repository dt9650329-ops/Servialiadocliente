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

exports.servibotChat = onCall({ secrets: [GEMINI_API_KEY] }, async (request) => {
  const { mensaje } = request.data;
  const clienteEmail = request.auth?.token?.email;

  if (!clienteEmail) {
    throw new HttpsError('unauthenticated', 'Debes iniciar sesión para usar ServiBot.');
  }
  if (!mensaje) {
    throw new HttpsError('invalid-argument', 'Falta el mensaje.');
  }

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY.value());
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash', tools: herramientas });

  const chat = model.startChat();
  const result = await chat.sendMessage(mensaje);
  const call = result.response.functionCalls()?.[0];

  if (call && call.name === 'consultarEstadoPedido') {
    const datosPedido = await consultarEstadoPedido(clienteEmail);
    const result2 = await chat.sendMessage([
      { functionResponse: { name: 'consultarEstadoPedido', response: datosPedido } },
    ]);
    return { respuesta: result2.response.text() };
  }

  return { respuesta: result.response.text() };
});
