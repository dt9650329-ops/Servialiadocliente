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

// NOTA: se agregó clienteIdAsignado como fallback más porque es el campo que
// index.html realmente usa para leer el pedido del cliente (ver clienteIdAsignado
// en index.html). Se deja clienteUID/clienteId por si pedidos_historial guarda
// otro nombre — no estorban, solo son fallback en cascada.
function obtenerClienteUID(pedido) {
  return pedido.clienteUID || pedido.clienteId || pedido.clienteIdAsignado;
}

// NUEVO: igual que obtenerClienteUID pero para el repartidor, con los mismos
// nombres de campo que usa index.html (repartidorIdAsignado / repartidorUID / repartidorId)
function obtenerRepartidorUID(pedido) {
  return pedido.repartidorIdAsignado || pedido.repartidorUID || pedido.repartidorId;
}

// Quita el prefijo "cliente_auth_" para poder leer usuarios/{uid}/fcmToken.
// El admin escribe notificaciones tanto en "cliente_auth_UID" como en "UID" —
// ver la lógica de _suscribirPath en index.html.
function _uidBase(path) {
  return String(path || '').replace(/^(cliente_auth_)+/, '');
}

// Mensaje nuevo en el chat — AHORA en ambas direcciones (antes solo avisaba
// al cliente cuando escribía el repartidor; faltaba avisar al repartidor
// cuando escribe el cliente)
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

// Cambio de estado del pedido (sin cambios)
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

// NUEVO: avisos individuales de admin (y cualquier otro que escriba en
// notificaciones_usuario) — cubre lo que el cliente escucha con
// onChildAdded en notificaciones_usuario/{path} dentro de index.html.
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
