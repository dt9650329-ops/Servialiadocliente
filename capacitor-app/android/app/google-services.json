const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

async function enviarPush(uid, title, body, data = {}) {
  const tokenSnap = await admin.database().ref(`usuarios/${uid}/fcmToken`).get();
  if (!tokenSnap.exists()) return;
  const token = tokenSnap.val();
  const message = {
    token,
    notification: { title, body },
    data,
    android: { priority: 'high' }
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
  return pedido.clienteUID || pedido.clienteId;
}

// Mensaje nuevo del repartidor al cliente
exports.onNuevoMensajeChat = functions.database
  .ref('/chat_p2p/{pedidoId}/{msgId}')
  .onCreate(async (snap, context) => {
    const m = snap.val();
    if (!m || m.remitente !== 'repartidor') return null;

    const pedidoId = context.params.pedidoId;
    const pedidoSnap = await admin.database().ref(`pedidos_historial/${pedidoId}`).get();
    if (!pedidoSnap.exists()) return null;
    const pedido = pedidoSnap.val();
    const clienteUID = obtenerClienteUID(pedido);
    if (!clienteUID) return null;

    const rep = m.repartidorNombre || 'Tu repartidor';
    const texto = m.texto || (m.tipo === 'imagen' ? 'Imagen' : m.tipo === 'audio' ? 'Audio' : '');
    await enviarPush(
      clienteUID,
      'Mensaje de ' + rep,
      rep + ' te escribió' + (texto ? ': "' + texto + '"' : ''),
      { pedidoId, tipo: 'chat_p2p' }
    );
    return null;
  });

// Cambio de estado del pedido
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
