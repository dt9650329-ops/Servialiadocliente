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
