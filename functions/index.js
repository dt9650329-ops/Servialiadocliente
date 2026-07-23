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

    // FIX: cuando un pedido AGENDADO (creado por ServiBot) se entrega o se
    // cancela por una vía distinta al chat (ej. el admin lo cancela, o
    // simplemente se completa normalmente), había que "cerrar" también su
    // registro en agendas_programadas/{uid}. Sin esto, ese nodo se quedaba
    // en estado 'vinculada' para siempre, y el cliente quedaba bloqueado
    // sin poder agendar un nuevo domicilio ("ya tienes uno activo"), ni
    // cancelarlo desde el chat (porque ya tenía repartidor asignado).
    if (['completado', 'entregado', 'cancelado'].includes(nuevoEstado) && pedido.tipo === 'domicilio_chatbot') {
      const agendaSnap = await admin.database().ref(`agendas_programadas/${clienteUID}`).get();
      if (agendaSnap.exists() && agendaSnap.val().pedidoId === pedidoId) {
        const estadoAgenda = nuevoEstado === 'cancelado' ? 'cancelada' : 'completada';
        await admin.database().ref(`agendas_programadas/${clienteUID}`).update({ estado: estadoAgenda });
      }
    }

    return null;
  });

exports.onNuevaNotificacionUsuario = functions.database
  .ref('/notificaciones_usuario/{path}/{notifId}')
  .onCreate(async (snap, context) => {
    const n = snap.val();
    if (!n) return null;
    const pathCrudo = context.params.path;
    if (!pathCrudo) return null;

    // Probar primero la clave TAL CUAL llegó (así quedan guardados los
    // clientes en usuarios/, con el prefijo cliente_auth_ incluido).
    // Solo si ahí no hay token, probar sin el prefijo (repartidores u
    // otros casos). Esto evita el bug de buscar en la ruta equivocada
    // y que el push nunca se envíe aunque el dato sí se haya guardado.
    let tokenSnap = await admin.database().ref(`usuarios/${pathCrudo}/fcmToken`).get();
    let uidFinal = pathCrudo;
    if (!tokenSnap.exists()) {
      const uidSinPrefijo = _uidBase(pathCrudo);
      if (uidSinPrefijo !== pathCrudo) {
        tokenSnap = await admin.database().ref(`usuarios/${uidSinPrefijo}/fcmToken`).get();
        uidFinal = uidSinPrefijo;
      }
    }
    if (!tokenSnap.exists()) return null;

    await enviarPush(
      uidFinal,
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

// ----------------------------------------------------------------------
// GEOCODIFICACIÓN — misma estrategia que usa el cliente (index.html):
// Firebase /barrios/ (con coordenadas) → Nominatim. El diccionario local
// grande del cliente no se duplica aquí para no inflar el backend; si
// Firebase y Nominatim fallan, el pedido queda marcado "requiereMapeador".
// ----------------------------------------------------------------------
function normalizarTexto(s) {
  return String(s || '').toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

let _barriosCacheBackend = null;
async function cargarBarriosBackend() {
  if (_barriosCacheBackend) return _barriosCacheBackend;
  const resultado = {};
  try {
    const snap = await admin.database().ref('barrios').get();
    if (snap.exists()) {
      snap.forEach(child => {
        const d = child.val();
        let lat = null, lng = null;
        if (d.lat && (d.lng || d.lon)) { lat = parseFloat(d.lat); lng = parseFloat(d.lng || d.lon); }
        else if (d.coordenadas) { lat = parseFloat(d.coordenadas.lat); lng = parseFloat(d.coordenadas.lng || d.coordenadas.lon); }
        else if (d.ubicacion) { lat = parseFloat(d.ubicacion.lat); lng = parseFloat(d.ubicacion.lng || d.ubicacion.lon); }
        if (lat && lng && !isNaN(lat) && !isNaN(lng)) {
          const nombre = normalizarTexto(d.nombre || child.key || '');
          resultado[nombre] = { lat, lng };
          const keyNorm = normalizarTexto(child.key);
          if (keyNorm !== nombre) resultado[keyNorm] = { lat, lng };
        }
      });
    }
  } catch (e) { console.warn('Error cargando /barrios/ en backend:', e); }
  _barriosCacheBackend = resultado;
  return resultado;
}

async function resolverCoordsBarrio(nombreBarrio) {
  const clave = normalizarTexto(nombreBarrio);
  const barriosDB = await cargarBarriosBackend();
  if (barriosDB[clave]) return barriosDB[clave];
  for (const [key, c] of Object.entries(barriosDB)) {
    if (key.includes(clave) || clave.includes(key)) return c;
  }
  return await geocodificarTexto(nombreBarrio); // último respaldo, no debería usarse casi nunca
}

async function geocodificarTexto(texto) {
  if (!texto) return null;
  const clave = normalizarTexto(texto);

  // Estrategia 1: barrios con coordenadas guardados en Firebase
  const barriosDB = await cargarBarriosBackend();
  for (const [key, coords] of Object.entries(barriosDB)) {
    if (clave.includes(key) || key.includes(clave)) return coords;
  }

  // Estrategia 2: Nominatim (mismo servicio que usa el cliente)
  const variantes = [
    texto + ', Armenia, Quindio, Colombia',
    texto + ', Armenia, Colombia',
  ];
  for (const q of variantes) {
    try {
      const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=co&q=' + encodeURIComponent(q);
      const r = await fetch(url, { headers: { 'Accept-Language': 'es', 'User-Agent': 'ServiAliados-Bot/1.0' } });
      const d = await r.json();
      if (d && d.length > 0) return { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) };
    } catch (e) { console.warn('Nominatim error backend:', e); }
    await new Promise(res => setTimeout(res, 350));
  }
  return null;
}

function calcularDistanciaKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function precioSegunKm(km) {
  if (km <= 1.0) return 4000;
  if (km <= 3.1) return 5000;
  if (km <= 5.9) return 6000;
  if (km <= 7.5) return 7000;
  if (km <= 9.0) return 8000;
  if (km <= 10.5) return 9000;
  return 10000;
}

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
      {
        name: 'iniciarAgendaProgramada',
        description: 'Verifica si se puede agendar un pedido para una hora exacta más tarde. Solo pide la HORA; nunca pidas dirección, barrio, nombre ni teléfono por chat, eso se llena en un formulario que se abre automáticamente si la hora es válida.',
        parameters: {
          type: 'object',
          properties: {
            hora: { type: 'integer', description: 'Hora en formato 24h (0-23) a la que quiere que pasen a recoger.' },
            minuto: { type: 'integer', description: 'Minutos (0-59).' },
            dia: { type: 'string', enum: ['hoy', 'mañana'], description: 'Si el pedido es para hoy o mañana.' },
          },
          required: ['hora', 'minuto', 'dia'],
        },
      },
      {
        name: 'cancelarPedidoProgramado',
        description: 'Cancela el pedido agendado/programado del cliente autenticado, solo si todavía no tiene repartidor asignado. Úsala cuando el cliente pida cancelar su pedido agendado.',
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

function obtenerFechaBogota(offsetDias = 0) {
  const ahora = new Date(Date.now() + offsetDias * 86400000);
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(ahora);
  const obj = {};
  partes.forEach(p => { if (p.type !== 'literal') obj[p.type] = p.value; });
  return obj; // { year, month, day }
}

function calcularTimestampAgenda(dia, hora, minuto) {
  const { year, month, day } = obtenerFechaBogota(dia === 'mañana' ? 1 : 0);
  const iso = `${year}-${month}-${day}T${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')}:00-05:00`;
  return new Date(iso).getTime();
}

async function iniciarAgendaProgramada(clienteAuthUID, args) {
  const { hora, minuto, dia } = args || {};

  if (!clienteAuthUID) {
    return { disponible: false, mensaje: 'El cliente no ha iniciado sesión, no se puede agendar. Pídele que inicie sesión primero.' };
  }
  if (typeof hora !== 'number' || typeof minuto !== 'number' || hora < 0 || hora > 23 || minuto < 0 || minuto > 59) {
    return { disponible: false, mensaje: 'La hora indicada no es válida.' };
  }
  // MODO PRUEBAS: restricción de horario (8am-11pm) desactivada temporalmente.
  // Para reactivarla, descomentar el bloque de abajo.
  // if (hora < 8 || hora >= 23) {
  //   return { disponible: false, mensaje: 'El servicio solo opera de 8:00 AM a 11:00 PM. Pide otra hora dentro de ese rango.' };
  // }

  const timestampAgenda = calcularTimestampAgenda(dia, hora, minuto);
  // MODO PRUEBAS: anticipación mínima bajada de 15 a 3 minutos.
  if (timestampAgenda <= Date.now() + 3 * 60000) {
    return { disponible: false, mensaje: 'Esa hora está muy cerca o ya pasó. Debe agendarse con al menos 3 minutos de anticipación.' };
  }

  // ¿Ya tiene una agenda activa (sin cancelar/completar)?
  const agendaExistente = await admin.database().ref(`agendas_programadas/${clienteAuthUID}`).get();
  if (agendaExistente.exists()) {
    const ae = agendaExistente.val();
    if (ae.estado === 'programada' || ae.estado === 'vinculada') {
      return { disponible: false, mensaje: 'Ya tienes un pedido programado activo. Si quieres cambiarlo, primero pide cancelarlo.' };
    }
  }

  return { disponible: true, hora, minuto, dia };
}

async function confirmarAgendaConBarrios(clienteAuthUID, clienteEmail, args) {
  const {
    hora, minuto, dia, recogidaEnCasa,
    barrioRecogida, manzanaCasaRecogida, nombreRecogida, telefonoRecogida,
    barrioEntrega, manzanaCasaEntrega, nombreRecibe, telefonoRecibe,
  } = args || {};

  if (!clienteAuthUID) {
    return { agendado: false, mensaje: 'El cliente no ha iniciado sesión, no se puede agendar.' };
  }

  const timestampAgenda = calcularTimestampAgenda(dia, hora, minuto);
  const ahora = Date.now();
  // MODO PRUEBAS: anticipación mínima bajada de 15 a 3 minutos.
  if (timestampAgenda <= ahora + 3 * 60000) {
    return { agendado: false, mensaje: 'Esa hora ya no es válida, debe agendarse con al menos 3 minutos de anticipación.' };
  }

  const agendaExistente = await admin.database().ref(`agendas_programadas/${clienteAuthUID}`).get();
  if (agendaExistente.exists()) {
    const ae = agendaExistente.val();
    if (ae.estado === 'programada' || ae.estado === 'vinculada') {
      return { agendado: false, mensaje: 'Ya tienes un pedido programado activo.' };
    }
  }

  // --- Recogida ---
  let dirRecogidaTexto, coordsRec = null, nombreRecogidaFinal = null, telefonoRecogidaFinal = null;
  if (recogidaEnCasa) {
    const dirSnap = await admin.database().ref(`usuarios/${clienteAuthUID}/direccion`).get();
    if (!dirSnap.exists() || !dirSnap.val()) {
      return { agendado: false, mensaje: 'No hay ninguna dirección registrada en tu perfil.' };
    }
    dirRecogidaTexto = dirSnap.val();

    // FIX: usar la ubicación GPS real del cliente en vez de geocodificar el
    // texto de la dirección (poco confiable y causaba "999.0 km" / "Recoge en: —"
    // en la app del repartidor). Prioridad:
    //   1) ubicación en vivo (ubicaciones_clientes), si es reciente (<30 min)
    //   2) ubicación capturada en el registro (usuarios/.../ubicacionRegistro)
    //   3) geocodificar el texto como último recurso
    const liveSnap = await admin.database().ref(`ubicaciones_clientes/${clienteAuthUID}`).get();
    if (liveSnap.exists()) {
      const live = liveSnap.val();
      const antiguedadMin = (Date.now() - (live.ts || 0)) / 60000;
      if (live.lat && live.lng && antiguedadMin < 30) {
        coordsRec = { lat: live.lat, lng: live.lng };
      }
    }
    if (!coordsRec) {
      const regSnap = await admin.database().ref(`usuarios/${clienteAuthUID}/ubicacionRegistro`).get();
      if (regSnap.exists()) {
        const reg = regSnap.val();
        if (reg.lat && reg.lat !== 'N/A' && (reg.lon || reg.lng)) {
          coordsRec = { lat: parseFloat(reg.lat), lng: parseFloat(reg.lon || reg.lng) };
        }
      }
    }
    if (!coordsRec) {
      coordsRec = await geocodificarTexto(dirRecogidaTexto);
    }
  } else {
    if (!barrioRecogida || !manzanaCasaRecogida || !nombreRecogida || !telefonoRecogida) {
      return { agendado: false, mensaje: 'Faltan datos de recogida (barrio, manzana/casa, nombre o teléfono).' };
    }
    coordsRec = await resolverCoordsBarrio(barrioRecogida);
    dirRecogidaTexto = `${barrioRecogida}, ${manzanaCasaRecogida}`;
    nombreRecogidaFinal = nombreRecogida;
    telefonoRecogidaFinal = telefonoRecogida;
  }

  // --- Entrega ---
  if (!barrioEntrega || !manzanaCasaEntrega || !nombreRecibe || !telefonoRecibe) {
    return { agendado: false, mensaje: 'Faltan datos de entrega (barrio, manzana/casa, nombre o teléfono).' };
  }
  const coordsEnt = await resolverCoordsBarrio(barrioEntrega);
  const direccionEntrega = `${barrioEntrega}, ${manzanaCasaEntrega}`;

  let montoTotal = null;
  let razonPrecio = 'Pendiente de confirmar por el administrador';
  let requiereMapeador = false;

  if (coordsRec && coordsEnt) {
    const km = calcularDistanciaKm(coordsRec, coordsEnt);
    montoTotal = precioSegunKm(km);
    razonPrecio = `Estimado automáticamente por distancia (${km.toFixed(1)} km)`;
  } else {
    requiereMapeador = true;
    razonPrecio = 'No se pudo ubicar automáticamente una de las direcciones; falta confirmar en el mapa';
  }

  let clienteNombre = 'Cliente';
  const uSnap = await admin.database().ref(`usuarios/${clienteAuthUID}`).get();
  if (uSnap.exists()) clienteNombre = uSnap.val().nombre || 'Cliente';

  const codigoEntrega = String(Math.floor(1000 + Math.random() * 9000));

  const pedidoData = {
    tipo: 'domicilio_chatbot',
    estado: 'programado',
    programadoPara: timestampAgenda,
    codigoEntrega,
    dirRecogida: dirRecogidaTexto,
    nombreRecogida: nombreRecogidaFinal,
    telefonoRecogida: telefonoRecogidaFinal,
    // FIX: sin estos campos, los mapas del cliente y del repartidor no
    // tienen coordenadas ni nombre de barrio para dibujar los marcadores
    // de recogida/entrega (agregarMarcadorRecogida/agregarMarcadorEntrega
    // buscan primero gpsRecogida/gpsDestino, y si no existen, caen a
    // barrioRecogida/barrioEntrega).
    barrioRecogida: recogidaEnCasa ? null : barrioRecogida,
    gpsRecogida: coordsRec ? { lat: coordsRec.lat, lng: coordsRec.lng } : null,
    direccionCliente: direccionEntrega,
    nombreRecibe,
    telefonoCliente: telefonoRecibe,
    barrioEntrega,
    gpsDestino: coordsEnt ? { lat: coordsEnt.lat, lng: coordsEnt.lng } : null,
    montoTotal,
    montoOriginal: montoTotal,
    razonPrecio,
    requiereMapeador,
    descripcion: `De "${dirRecogidaTexto}" a "${direccionEntrega}" (agendado por ServiBot)`,
    clienteIdAsignado: clienteAuthUID,
    clienteNombre,
    clienteEmail: clienteEmail || null,
    repartidorUID: null,
    repartidorNombre: 'Sin asignar',
    timestampCreacion: ahora,
    fecha: new Date().toISOString(),
  };

  const nuevoPedido = await admin.database().ref('pedidos_historial').push(pedidoData);
  const pedidoId = nuevoPedido.key;

  await admin.database().ref(`agendas_programadas/${clienteAuthUID}`).set({
    horaProgramada: timestampAgenda,
    estado: 'vinculada',
    pedidoId,
    creadoEn: ahora,
    clienteEmail: clienteEmail || null,
  });

  const horaTexto = new Date(timestampAgenda).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' });

  return {
    agendado: true,
    pedidoId,
    horaProgramada: horaTexto,
    montoEstimado: montoTotal,
    requiereMapeador,
    mensaje: requiereMapeador
      ? `Tu pedido quedó agendado para las ${horaTexto}, pero no pude calcular el precio exacto automáticamente; el valor queda pendiente de confirmar.`
      : `¡Listo! Tu pedido se ha programado con éxito para las ${horaTexto}. Recogida: ${dirRecogidaTexto}. Entrega: ${direccionEntrega}, para ${nombreRecibe}. Tarifa estimada: $${montoTotal.toLocaleString('es-CO')}.`,
  };
}

async function cancelarPedidoProgramado(clienteAuthUID) {
  if (!clienteAuthUID) {
    return { cancelado: false, mensaje: 'El cliente no ha iniciado sesión, no se puede cancelar.' };
  }

  const agendaSnap = await admin.database().ref(`agendas_programadas/${clienteAuthUID}`).get();
  if (!agendaSnap.exists()) {
    return { cancelado: false, mensaje: 'No tienes ningún pedido programado activo.' };
  }
  const agenda = agendaSnap.val();
  if (agenda.estado === 'cancelada') {
    return { cancelado: false, mensaje: 'Ese pedido programado ya estaba cancelado.' };
  }
  if (!agenda.pedidoId) {
    await admin.database().ref(`agendas_programadas/${clienteAuthUID}`).update({ estado: 'cancelada' });
    return { cancelado: true, mensaje: 'Tu pedido programado fue cancelado.' };
  }

  const pedidoSnap = await admin.database().ref(`pedidos_historial/${agenda.pedidoId}`).get();
  if (!pedidoSnap.exists()) {
    await admin.database().ref(`agendas_programadas/${clienteAuthUID}`).update({ estado: 'cancelada' });
    return { cancelado: true, mensaje: 'Tu pedido programado fue cancelado.' };
  }
  const pedido = pedidoSnap.val();

  // Solo se puede cancelar por chat si NINGÚN repartidor lo ha aceptado todavía
  if (pedido.estado !== 'programado' || pedido.repartidorUID) {
    return {
      cancelado: false,
      mensaje: 'Tu pedido ya tiene un repartidor asignado (o está en curso), así que ya no se puede cancelar desde el chat. Escribe al chat de soporte para gestionarlo.',
    };
  }

  await admin.database().ref(`pedidos_historial/${agenda.pedidoId}`).update({ estado: 'cancelado' });
  await admin.database().ref(`agendas_programadas/${clienteAuthUID}`).update({ estado: 'cancelada' });

  return { cancelado: true, mensaje: 'Listo, tu pedido agendado fue cancelado con éxito.' };
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
[MODO PRUEBAS: temporalmente sin restricción de horario, el servicio puede agendarse a cualquier hora]

— QUEJAS, SOPORTE Y HABLAR CON UNA PERSONA —
Existe un número directo del encargado, y dentro de la app hay un "chat de soporte" (botones
"Soporte WhatsApp" y "Soporte para Pedidos" en la pestaña Perfil) para hablar con una persona real.
Comparte esta información si el cliente pide explícitamente cualquiera de estas cosas: una queja,
un reclamo, hablar con el administrador o el dueño, hablar con una persona/humano, o dice que
ServiBot no le está ayudando. NO lo menciones proactivamente en respuestas generales sobre otros temas.
Cuando aplique, ofrece ambas opciones:
- El chat de soporte dentro de la app (botones "Soporte WhatsApp" / "Soporte para Pedidos" en Perfil)
- WhatsApp directo del encargado: 3137065977

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

— PEDIDOS PROGRAMADOS (AGENDAR PARA UNA HORA EXACTA) —
Si el cliente quiere agendar, pide SOLO la hora exacta (hora, minuto, hoy o mañana) y llama a
iniciarAgendaProgramada. NUNCA pidas barrio, dirección, nombre ni teléfono por chat: esos datos
se llenan en un formulario que se abre solo en la app justo después de confirmar la hora. Si la
hora no es válida o ya tiene agenda activa, explícalo con claridad. Si es válida, dile brevemente
que complete el barrio de recogida y entrega en el formulario que se acaba de abrir.
Si el cliente pide cancelar, usa cancelarPedidoProgramado. Si la respuesta indica que ya tiene
repartidor asignado, explícale que ya no se puede cancelar por chat y que debe escribir al chat
de soporte.

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
- [MODO PRUEBAS: sin restricción de horario por ahora]
- Mantente siempre en temas de Servi Aliados (precios, zonas, tiempos, pedidos, cuenta, etc). Si
  te preguntan algo totalmente ajeno (chistes, tareas, trivia, clima), redirige amablemente al tema.`;
}

exports.servibotChat = onCall({ secrets: [GEMINI_API_KEY] }, async (request) => {
  const { mensaje, historial } = request.data;
  const clienteEmail = request.auth?.token?.email || null;
  const clienteAuthUID = request.auth?.uid ? `cliente_auth_${request.auth.uid}` : null;
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

  if (call && call.name === 'iniciarAgendaProgramada') {
    const disp = await iniciarAgendaProgramada(clienteAuthUID, call.args || {});
    const result2 = await chat.sendMessage([
      { functionResponse: { name: 'iniciarAgendaProgramada', response: disp } },
    ]);
    return {
      respuesta: result2.response.text(),
      accion: disp.disponible ? 'mostrarSelectorBarrios' : null,
      datosAgenda: disp.disponible ? { hora: disp.hora, minuto: disp.minuto, dia: disp.dia } : null,
    };
  }

  if (call && call.name === 'cancelarPedidoProgramado') {
    const datosCancel = await cancelarPedidoProgramado(clienteAuthUID);
    const result2 = await chat.sendMessage([
      { functionResponse: { name: 'cancelarPedidoProgramado', response: datosCancel } },
    ]);
    return { respuesta: result2.response.text() };
  }

  return { respuesta: result.response.text() };
});

// ======================================================================
// CONFIRMAR AGENDA CON BARRIOS SELECCIONADOS MANUALMENTE (sin IA) —
// llamada directamente por el formulario del chat una vez el cliente
// elige barrio de recogida/entrega de la lista, sin pasar por Gemini.
// ======================================================================
exports.confirmarAgendaConBarrios = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Debes iniciar sesión.');
  const clienteAuthUID = `cliente_auth_${uid}`;
  const clienteEmail = request.auth?.token?.email || null;

  const resultado = await confirmarAgendaConBarrios(clienteAuthUID, clienteEmail, request.data || {});
  if (!resultado.agendado) {
    throw new HttpsError('failed-precondition', resultado.mensaje || 'No se pudo agendar.');
  }
  return resultado;
});

// ======================================================================
// SECCIÓN "DOMICILIOS PROGRAMADOS" (cliente) — consultar, editar y
// cancelar el pedido agendado directamente desde la app, sin pasar por
// el chat. Reutiliza la misma lógica que ya usa ServiBot.
// ======================================================================

// Consulta si el cliente autenticado tiene un domicilio programado activo,
// y si puede editarlo o cancelarlo (solo si aún no tiene repartidor asignado).
exports.miAgendaProgramada = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Debes iniciar sesión.');
  const clienteAuthUID = `cliente_auth_${uid}`;

  const agendaSnap = await admin.database().ref(`agendas_programadas/${clienteAuthUID}`).get();
  if (!agendaSnap.exists()) return { tieneAgenda: false };

  const agenda = agendaSnap.val();
  if (agenda.estado !== 'vinculada' && agenda.estado !== 'programada') {
    return { tieneAgenda: false };
  }
  if (!agenda.pedidoId) return { tieneAgenda: false };

  const pedidoSnap = await admin.database().ref(`pedidos_historial/${agenda.pedidoId}`).get();
  if (!pedidoSnap.exists()) return { tieneAgenda: false };
  const pedido = pedidoSnap.val();

  const puedeGestionar = pedido.estado === 'programado' && !pedido.repartidorUID;

  return {
    tieneAgenda: true,
    pedidoId: agenda.pedidoId,
    horaProgramada: agenda.horaProgramada,
    estadoPedido: pedido.estado,
    editable: puedeGestionar,
    cancelable: puedeGestionar,
    dirRecogida: pedido.dirRecogida || null,
    barrioEntrega: pedido.barrioEntrega || null,
    direccionEntrega: pedido.direccionCliente || null,
    nombreRecibe: pedido.nombreRecibe || null,
    telefonoCliente: pedido.telefonoCliente || null,
    montoTotal: pedido.montoTotal || null,
    repartidorNombre: pedido.repartidorNombre || 'Sin asignar',
  };
});

// Cancela el domicilio programado directamente desde la sección (botón),
// sin pasar por Gemini. Usa la misma función que ya usa ServiBot.
exports.cancelarAgendaDirecto = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Debes iniciar sesión.');
  const clienteAuthUID = `cliente_auth_${uid}`;
  const resultado = await cancelarPedidoProgramado(clienteAuthUID);
  if (!resultado.cancelado) {
    throw new HttpsError('failed-precondition', resultado.mensaje || 'No se pudo cancelar.');
  }
  return resultado;
});

// Permite corregir datos de entrega (nombre, teléfono, barrio/dirección)
// del domicilio programado, solo mientras no tenga repartidor asignado.
exports.editarAgendaProgramada = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Debes iniciar sesión.');
  const clienteAuthUID = `cliente_auth_${uid}`;
  const { nombreRecibe, telefonoCliente, barrioEntrega, manzanaCasaEntrega } = request.data || {};

  const agendaSnap = await admin.database().ref(`agendas_programadas/${clienteAuthUID}`).get();
  if (!agendaSnap.exists() || !agendaSnap.val().pedidoId) {
    throw new HttpsError('failed-precondition', 'No tienes ningún pedido programado activo.');
  }
  const pedidoId = agendaSnap.val().pedidoId;
  const pedidoSnap = await admin.database().ref(`pedidos_historial/${pedidoId}`).get();
  if (!pedidoSnap.exists()) {
    throw new HttpsError('failed-precondition', 'No se encontró el pedido programado.');
  }
  const pedido = pedidoSnap.val();
  if (pedido.estado !== 'programado' || pedido.repartidorUID) {
    throw new HttpsError('failed-precondition', 'Ya no se puede editar: el pedido ya tiene un repartidor asignado o está en curso.');
  }

  const updates = {};
  if (nombreRecibe) updates.nombreRecibe = nombreRecibe;
  if (telefonoCliente) updates.telefonoCliente = telefonoCliente;

  if (barrioEntrega && manzanaCasaEntrega) {
    const coordsEnt = await resolverCoordsBarrio(barrioEntrega);
    updates.barrioEntrega = barrioEntrega;
    updates.direccionCliente = `${barrioEntrega}, ${manzanaCasaEntrega}`;
    updates.descripcion = `De "${pedido.dirRecogida}" a "${updates.direccionCliente}" (agendado por ServiBot)`;
    if (coordsEnt) {
      updates.gpsDestino = { lat: coordsEnt.lat, lng: coordsEnt.lng };
      if (pedido.gpsRecogida) {
        const km = calcularDistanciaKm(pedido.gpsRecogida, coordsEnt);
        updates.montoTotal = precioSegunKm(km);
        updates.montoOriginal = updates.montoTotal;
        updates.razonPrecio = `Estimado automáticamente por distancia (${km.toFixed(1)} km)`;
      }
    }
  }

  if (Object.keys(updates).length === 0) {
    throw new HttpsError('invalid-argument', 'No enviaste ningún dato para actualizar.');
  }

  await admin.database().ref(`pedidos_historial/${pedidoId}`).update(updates);
  return { editado: true, mensaje: 'Tus datos fueron actualizados con éxito.' };
});

// ======================================================================
// AGENDA — Activa automáticamente los pedidos programados según demanda
// ======================================================================
exports.asignarPedidosProgramados = functions.pubsub
  .schedule('every 2 minutes')
  .timeZone('America/Bogota')
  .onRun(async () => {
    const progSnap = await admin.database()
      .ref('pedidos_historial')
      .orderByChild('estado')
      .equalTo('programado')
      .get();
    if (!progSnap.exists()) return null;

    // Medir la carga actual UNA vez por corrida
    const repSnap = await admin.database().ref('repartidores_info').get();
    const disponibles = repSnap.exists()
      ? Object.entries(repSnap.val())
          .map(([uid, r]) => ({ uid, ...r }))
          .filter(r => r.online === true)
      : [];

    const activosSnap = await admin.database()
      .ref('pedidos_historial')
      .orderByChild('estado')
      .equalTo('pendiente')
      .get();
    const numPedidosActivos = activosSnap.exists() ? Object.keys(activosSnap.val()).length : 0;
    const numDisponibles = Math.max(disponibles.length, 1);
    const ratio = numPedidosActivos / numDisponibles;

    // Ventana dinámica: más demanda → se asigna con más anticipación
    let ventanaMin = 15;
    if (ratio >= 2) ventanaMin = 60;
    else if (ratio >= 1) ventanaMin = 30;

    const ahora = Date.now();

    for (const [pedidoId, pedido] of Object.entries(progSnap.val())) {
      const minutosRestantes = (pedido.programadoPara - ahora) / 60000;
      if (minutosRestantes > ventanaMin) continue; // todavía no toca

      const candidatos = disponibles
        .slice()
        .sort((a, b) => (a.pedidosActivos || 0) - (b.pedidosActivos || 0));

      let repartidorGanador = null;
      for (const cand of candidatos) {
        const ref = admin.database().ref(`repartidores_info/${cand.uid}/pedidosActivos`);
        const tx = await ref.transaction(actual => {
          if ((actual || 0) >= 3) return actual; // ya está lleno, aborta
          return (actual || 0) + 1;
        });
        if (tx.committed) { repartidorGanador = cand; break; }
      }

      if (repartidorGanador) {
        const updates = {
          estado: 'pendiente',
          repartidorUID: repartidorGanador.uid,
          repartidorNombre: repartidorGanador.nombre || 'Repartidor',
          timestampAsignacion: ahora,
        };
        await admin.database().ref(`pedidos_historial/${pedidoId}`).update(updates);
        await admin.database().ref(`pedidos_pendientes/${pedidoId}`).set({ ...pedido, ...updates, pedidoId, historialId: pedidoId });

        // FIX: sin esto, el pedido queda "asignado" en la base de datos pero
        // nunca aparece en la pantalla del repartidor, porque su app solo
        // escucha repartidores_pedidos/{uid}/{pedidoId} (no pedidos_historial
        // directamente) para la lista de pedidos pendientes/asignados.
        await admin.database().ref(`repartidores_pedidos/${repartidorGanador.uid}/${pedidoId}`).set({
          ...pedido,
          ...updates,
        });

        await enviarPush(repartidorGanador.uid, 'Pedido agendado activado', 'Tienes un pedido programado listo para recoger.', { pedidoId, tipo: 'pedido_programado' });
        const clienteUID = obtenerClienteUID(pedido);
        if (clienteUID) {
          await enviarPush(clienteUID, 'Repartidor asignado', `${repartidorGanador.nombre || 'Tu repartidor'} fue asignado a tu pedido agendado.`, { pedidoId, tipo: 'pedido_programado' });
        }
      } else if (minutosRestantes <= -10 && !pedido.avisoRetrasoEnviado) {
        await admin.database().ref(`notificaciones_admin/retraso_${pedidoId}`).set({
          titulo: 'Pedido agendado sin repartidor',
          mensaje: `El pedido ${pedidoId} debía recogerse a las ${new Date(pedido.programadoPara).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota' })} y no hay repartidores disponibles.`,
          timestamp: ahora,
        });
        await admin.database().ref(`pedidos_historial/${pedidoId}/avisoRetrasoEnviado`).set(true);
        const clienteUID = obtenerClienteUID(pedido);
        if (clienteUID) {
          await enviarPush(clienteUID, 'Seguimos en eso', 'Estamos buscando repartidor disponible para tu pedido agendado, te avisamos apenas se asigne.', { pedidoId, tipo: 'pedido_programado_retraso' });
        }
      }
    }
    return null;
  });

exports.redimirCupon = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Debes iniciar sesión.');
  const { codigo } = request.data || {};
  if (!codigo) throw new HttpsError('invalid-argument', 'Falta el código del cupón.');
  const clienteAuthUID = `cliente_auth_${uid}`;
  const otorgadosRef = admin.database().ref(`bonosOtorgados/${clienteAuthUID}`);
  const otorgadosSnap = await otorgadosRef.once('value');
  if (otorgadosSnap.exists()) {
    const bonos = otorgadosSnap.val();
    const bonoId = Object.keys(bonos).find(id => bonos[id] && bonos[id].codigo === codigo && !bonos[id].usado);
    if (bonoId) {
      const bonoRef = admin.database().ref(`bonosOtorgados/${clienteAuthUID}/${bonoId}`);
      const resultOtorgado = await bonoRef.transaction((bono) => {
        if (!bono || bono.usado) return bono;
        bono.usado = true;
        return bono;
      });
      if (resultOtorgado.committed && resultOtorgado.snapshot.val() && resultOtorgado.snapshot.val().usado === true) {
        return { ok: true };
      }
      return { ok: false, mensaje: 'Ese cupón no existe o ya fue usado.' };
    }
  }
  const premiosRef = admin.database().ref(`usuarios/${clienteAuthUID}/premios`);
  const result = await premiosRef.transaction((premios) => {
    if (!premios) return premios;
    const bonosAcum = premios.bonosAcum || [];
    const idx = bonosAcum.findIndex(b => b.codigo === codigo && !b.redimido);
    if (idx === -1) return;
    bonosAcum[idx].redimido = true;
    premios.bonosAcum = bonosAcum;
    premios.creditos = Math.max(0, (premios.creditos || 0) - (bonosAcum[idx].monto || 0));
    return premios;
  });
  if (!result.committed) {
    return { ok: false, mensaje: 'Ese cupón no existe o ya fue usado.' };
  }
  return { ok: true };
});
