const functions = require('firebase-functions');
const admin = require('firebase-admin');
const https = require('https');
admin.initializeApp();

async function enviarPush(uid, title, body, data = {}) {
  const tokenSnap = await admin.database().ref(`usuarios/${uid}/fcmToken`).get();
  if (!tokenSnap.exists()) {
    // ANTES: esto retornaba en silencio y quien llamaba a enviarPush
    // nunca se enteraba de que NO se envió nada (ver avisarRepartidorOlvido,
    // que por esto le decía "ya le avisé" al cliente aunque no hubiera token).
    console.warn(`[enviarPush] SIN TOKEN para uid="${uid}" — no se envió "${title}"`);
    return { enviado: false, motivo: 'sin_token' };
  }
  const token = tokenSnap.val();
  const tonoSnap = await admin.database().ref(`usuarios/${uid}/tonoNotificacion`).get();
  const tono = tonoSnap.exists() ? tonoSnap.val() : '1';
  // channelId configurable: los avisos urgentes (aviso_cliente_devolver) usan
  // un canal propio con vibración fuerte en vez del canal normal de tono,
  // así el repartidor los distingue de una notificación de pedido común.
  // NOTA v1.0.1: se renombró de 'aviso_urgente_repartidor' a
  // 'aviso_urgente_repartidor_v2' porque los canales de notificación de
  // Android son inmutables una vez creados — como el canal viejo ya existía
  // en los celulares (creado automáticamente sin vibración antes de que
  // existiera el createChannel() del cliente), cambiarle la configuración
  // no tenía ningún efecto. Con un id nuevo, Android lo crea de cero con
  // vibración habilitada.
  // NOTA v1.0.7 (cliente): la app del CLIENTE crea sus canales de tono con
  // el nombre 'tono_notif_N' (ver _crearCanalesTono en su index.html), pero
  // aquí se estaba mandando 'pedidos_tonoN' — como nunca coincidían,
  // cualquier push al cliente (incluido el aviso de "tu repartidor ya vio
  // tu aviso") caía en un canal genérico sin sonido cuando la app estaba en
  // segundo plano o cerrada. Los uid de cliente siempre llegan con el
  // prefijo 'cliente_auth_', así que se usa eso para elegir el canal
  // correcto sin tener que tocar cada función que llama a enviarPush.
  const esCliente = String(uid).startsWith('cliente_auth_');
  const channelId = data && data.tipo === 'aviso_cliente_devolver'
    ? 'aviso_urgente_repartidor_v2'
    : esCliente ? 'tono_notif_' + tono : 'pedidos_tono' + tono;
  const message = {
    token,
    notification: { title, body },
    data,
    android: {
      priority: 'high',
      notification: {
        channelId,
        // 'sound: default' fuerza el tono por defecto del canal si el
        // canal no está creado todavía en el dispositivo (fallback).
        sound: 'default',
      }
    }
  };
  try {
    await admin.messaging().send(message);
    return { enviado: true };
  } catch (e) {
    console.error('Error enviando push a', uid, e);
    if (e.code === 'messaging/registration-token-not-registered') {
      await admin.database().ref(`usuarios/${uid}/fcmToken`).remove();
    }
    return { enviado: false, motivo: 'error_envio', error: e.code || String(e) };
  }
}

function obtenerClienteUID(pedido) {
  return pedido.clienteUID || pedido.clienteId || pedido.clienteIdAsignado;
}

function obtenerRepartidorUID(pedido) {
  const raw = pedido.repartidorIdAsignado || pedido.repartidorUID || pedido.repartidorId;
  return _repartidorUidBase(raw);
}

function _uidBase(path) {
  return String(path || '').replace(/^(cliente_auth_)+/, '');
}

// repartidorIdAsignado se guarda en el pedido CON el prefijo "repartidor_"
// pegado, pero usuarios/, repartidores_info/ y avisos_repartidor/ usan el
// UID crudo de Firebase Auth como clave (sin prefijo). Mismo bug que
// _uidBase mas arriba, pero con el prefijo del repartidor.
function _repartidorUidBase(path) {
  return String(path || '').replace(/^(repartidor_)+/, '');
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

// AVISO "REPARTIDOR CERCA": el repartidor (app) marca este campo en
// pedidos_historial cuando su GPS queda a menos de ~400m del punto de
// entrega y el pedido va "En Camino". Este trigger detecta esa marca y le
// manda el push al cliente — mismo patrón que onCambioEstadoPedido de
// arriba, solo que dispara por este campo en vez de por 'estado'.
exports.onRepartidorCerca = functions.database
  .ref('/pedidos_historial/{pedidoId}/repartidorCerca')
  .onCreate(async (snap, context) => {
    if (snap.val() !== true) return null;
    const pedidoId = context.params.pedidoId;
    const pedidoSnap = await admin.database().ref(`pedidos_historial/${pedidoId}`).get();
    if (!pedidoSnap.exists()) return null;
    const pedido = pedidoSnap.val();
    const clienteUID = obtenerClienteUID(pedido);
    if (!clienteUID) return null;

    const rep = pedido.repartidorNombre || 'Tu repartidor';
    await enviarPush(
      clienteUID,
      '¡Tu repartidor está cerca!',
      `${rep} está a pocos minutos de llegar. Prepárate para recibir tu pedido.`,
      { pedidoId, tipo: 'repartidor_cerca' }
    );
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

// Verifica si un barrio ya está registrado en /barrios/ (Firebase), SIN caer
// a Nominatim como resolverCoordsBarrio. Se usa para bloquear el guardado de
// un cliente/dirección nueva si el barrio todavía no está en la base de datos.
async function barrioRegistrado(nombreBarrio) {
  if (!nombreBarrio) return false;
  const clave = normalizarTexto(nombreBarrio);
  const barriosDB = await cargarBarriosBackend();
  if (barriosDB[clave]) return true;
  for (const key of Object.keys(barriosDB)) {
    if (key.includes(clave) || clave.includes(key)) return true;
  }
  return false;
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

// FIX PRECIO SERVIBOT: el precio que ve el cliente en el formulario normal se
// calcula con la distancia REAL por carretera (OSRM), pero todo lo que pasaba
// por ServiBot (pedido para tercero, cotizarPorUbicacion, agenda con barrios)
// usaba línea recta (calcularDistanciaKm/Haversine) — por eso el mismo
// domicilio salía más barato por ServiBot que por el formulario manual.
// Esta función intenta la distancia real y solo cae a línea recta si OSRM falla.
// FIX ESTIMADO SIN OSRM: la línea recta siempre da MENOS que la ruta real
// (calles, curvas, ríos, lomas) — se corrige con este factor para que el
// estimado no se quede corto cuando OSRM no responde.
const FACTOR_CORRECCION_RUTA = 1.25; // +25% sobre la línea recta
async function calcularDistanciaRutaKm(a, b) {
  if (!a || !b) return null;
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.routes && data.routes[0]) return data.routes[0].distance / 1000;
  } catch (e) {
    console.warn('[PRECIO SERVIBOT] OSRM no disponible, usando línea recta:', e);
  }
  return calcularDistanciaKm(a, b) * FACTOR_CORRECCION_RUTA;
}

function precioSegunKm(km) {
  if (km <= 1.0) return 4000;
  if (km <= 3.1) return 5000;
  if (km <= 5.9) return 6000;
  if (km <= 7.5) return 7000;
  if (km <= 9.0) return 8000;
  if (km <= 10.5) return 9000;
  // A partir de aquí ya no es "dentro de Armenia": son destinos hacia
  // municipios vecinos (La Tebaida, Calarcá, Circasia, Montenegro, etc.),
  // habilitados solo desde que se puede cotizar por ubicación GPS exacta.
  if (km <= 13) return 12000;
  if (km <= 16) return 16000;
  if (km <= 19) return 20000;
  if (km <= 22) return 25000;
  if (km <= 25) return 30000;
  if (km <= 28) return 35000;
  if (km <= 30) return 40000;
  // Más de 30 km: fuera de cobertura automática, requiere que un
  // administrador confirme el precio manualmente.
  return null;
}

// Extrae {lat,lng} de una URL de Google Maps ya expandida (no funciona con
// links cortos tipo maps.app.goo.gl, hay que resolverlos primero).
// Formatos soportados: .../@4.533,-75.681,17z  |  ?q=4.533,-75.681  |  ?ll=4.533,-75.681
function extraerCoordsDeGoogleMapsURL(texto) {
  if (!texto) return null;
  const patrones = [
    /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,
    /@(-?\d+\.\d+),(-?\d+\.\d+)/,
    /[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/,
    /[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/,
  ];
  for (const p of patrones) {
    const m = texto.match(p);
    if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
  }
  return null;
}

// Los links cortos (maps.app.goo.gl, goo.gl/maps) no traen coordenadas en la
// URL: hay que seguir la redirección para obtener la URL larga real. Usa el
// módulo nativo "https" de Node (no depende de que exista fetch global, que
// varía según la versión de Node del runtime de Cloud Functions).
function seguirRedireccion(url, saltosRestantes) {
  return new Promise((resolve) => {
    if (saltosRestantes <= 0) return resolve(url);
    try {
      const req = https.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36' },
      }, (res) => {
        const { statusCode, headers } = res;
        res.resume(); // descartar el body, solo interesan los headers
        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          let siguienteUrl;
          try {
            siguienteUrl = new URL(headers.location, url).toString();
          } catch (e) {
            return resolve(url);
          }
          resolve(seguirRedireccion(siguienteUrl, saltosRestantes - 1));
        } else {
          resolve(url);
        }
      });
      req.on('error', (e) => {
        console.warn('Error resolviendo URL corta de Google Maps:', e.message);
        resolve(url);
      });
      req.setTimeout(6000, () => {
        req.destroy();
        resolve(url);
      });
    } catch (e) {
      console.warn('Error resolviendo URL corta de Google Maps:', e.message);
      resolve(url);
    }
  });
}

async function resolverURLCortaGoogleMaps(url) {
  if (!/goo\.gl|maps\.app\.goo\.gl/.test(url)) return url;
  const resuelta = await seguirRedireccion(url, 5);
  return resuelta || url;
}

// Punto de entrada único: recibe el texto que mandó el cliente (puede ser
// solo el link, o un mensaje con el link mezclado) y devuelve {lat,lng} o null.
async function extraerCoordsDeTextoUbicacion(texto) {
  if (!texto) return null;
  const directo = extraerCoordsDeGoogleMapsURL(texto);
  if (directo) return directo;
  const urlMatch = texto.match(/https?:\/\/\S+/);
  if (!urlMatch) return null;
  const urlResuelta = await resolverURLCortaGoogleMaps(urlMatch[0]);
  console.log('[Maps] Link original:', urlMatch[0], '-> resuelto:', urlResuelta);
  const coords = extraerCoordsDeGoogleMapsURL(urlResuelta);
  if (!coords) console.warn('[Maps] No se encontraron coordenadas en la URL resuelta.');
  return coords;
}

function etiquetaTiempoPreparacion(minutos) {
  const m = Number(minutos) || 0;
  return m <= 0 ? 'Ya está para recoger' : `Recoger en ${m} minutos`;
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
        description: 'Verifica si se puede agendar un pedido para una hora exacta más tarde. SIEMPRE pide la HORA. NUNCA pidas el barrio por chat (eso siempre se selecciona manualmente en el formulario que se abre). Pero si el cliente YA mencionó en su mensaje el nombre de quien recibe, su teléfono, y/o la dirección exacta, extráelos y pásalos como argumentos para que el formulario se abra pre-llenado con esos datos. La dirección puede venir en dos formatos: manzana/casa (ciudadelas — pásala SIN el barrio) o calle/carrera tradicional de Centro/Norte (ej. "Cra 14 #14-23" o "Calle 14N #14-23" — pásala tal cual la dio el cliente, completa, sin quitarle nada; el sistema detecta solo si es Centro o Norte por el formato, no hace falta que preguntes el barrio en ese caso tampoco).',
        parameters: {
          type: 'object',
          properties: {
            hora: { type: 'integer', description: 'Hora en formato 24h (0-23) a la que quiere que pasen a recoger.' },
            minuto: { type: 'integer', description: 'Minutos (0-59).' },
            dia: { type: 'string', enum: ['hoy', 'mañana'], description: 'Si el pedido es para hoy o mañana.' },
            nombreEntrega: { type: 'string', description: 'Nombre de quien recibe el pedido, SOLO si el cliente ya lo mencionó en el mensaje.' },
            telefonoEntrega: { type: 'string', description: 'Teléfono de quien recibe, SOLO si el cliente ya lo mencionó en el mensaje.' },
            direccionEntrega: { type: 'string', description: 'Manzana/casa/dirección exacta de entrega (SIN el barrio), SOLO si el cliente ya la mencionó en el mensaje.' },
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
      {
        name: 'consultarUbicacionPedido',
        description: 'Consulta la ubicación GPS actual del repartidor del pedido activo del cliente, para mostrarle un mini-mapa en el chat con dónde va. Úsala cuando el cliente pregunte cosas como "¿dónde va mi pedido?", "¿ya viene el repartidor?", "¿cuánto falta?", "¿dónde está mi domicilio?".',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'avisarRepartidorOlvido',
        description: 'Envía una notificación push URGENTE al repartidor que tiene el pedido activo del cliente, para casos como: se le olvidó algo al cliente, el repartidor se fue sin el pedido completo, o necesita devolverse. Úsala SOLO cuando el cliente pida explícitamente avisarle algo al repartidor sobre su pedido en curso. No la uses para quejas generales ni para hablar del estado del pedido.',
        parameters: {
          type: 'object',
          properties: {
            mensajeParaRepartidor: {
              type: 'string',
              description: 'Resumen corto y claro (máx 100 caracteres) de lo que el repartidor debe saber o hacer, en base a lo que dijo el cliente. Ej: "El cliente olvidó darte una bolsa adicional, por favor regresa por ella." o "Salió sin el pedido completo, por favor confirma con el cliente."',
            },
          },
          required: ['mensajeParaRepartidor'],
        },
      },
      {
        name: 'buscarClienteLocalGuardado',
        description: 'Busca si un cliente ya está guardado en la libreta de clientes recurrentes del LOCAL/NEGOCIO que está usando el chat, por nombre O por teléfono (cualquiera de los dos sirve, no hace falta dar ambos). La búsqueda por nombre ignora tildes/mayúsculas/espacios y encuentra coincidencias parciales (ej. "Camilo" encuentra "Camilo Pérez"). La libreta es PERSISTENTE entre conversaciones (no se borra al abrir un chat nuevo). Úsala SIEMPRE que el cliente autenticado esté pidiendo o preguntando por un domicilio PARA UN TERCERO (uno de sus propios clientes), no para sí mismo — por ejemplo: pega un mensaje reenviado con nombre/teléfono/dirección de otra persona, escribe algo como "mándame un repartidor para [nombre]" dando solo el nombre, o pregunta directamente "¿sabes quién es [nombre]?" / "¿la tienes guardada?". Llama esta herramienta ANTES de responder, incluso si el mensaje solo trae el nombre y ningún otro dato. IMPORTANTE: si el resultado trae "ambiguo: true" con una lista de "candidatos" (varios contactos parecidos al nombre buscado), NUNCA elijas uno por tu cuenta ni mezcles sus datos — muéstraselos al local (nombre y teléfono de cada uno) y pregúntale a cuál se refiere antes de cotizar o crear cualquier pedido.',
        parameters: {
          type: 'object',
          properties: {
            nombre: { type: 'string', description: 'Nombre del cliente a buscar, si se mencionó.' },
            telefono: { type: 'string', description: 'Teléfono del cliente a buscar, si se mencionó.' },
          },
        },
      },
      {
        name: 'iniciarPedidoParaTercero',
        description: 'Abre el formulario rápido para que el LOCAL complete de una vez un domicilio para un TERCERO (uno de sus propios clientes), en vez de preguntarle los datos uno por uno en el chat. Úsala tan pronto el local pegue o escriba los datos de un tercero pidiendo un domicilio para él — por ejemplo pega un mensaje reenviado con nombre/teléfono/dirección, o escribe algo como "mándame un repartidor para [nombre]" o "para recoger en el local y llevarle a [nombre] [teléfono] [dirección]". Extrae del mensaje lo que puedas: nombre, teléfono, y si viene una dirección, sepárala SOLO en direccionDetalle. NUNCA extraigas ni pases el barrio como parámetro, aunque el mensaje lo mencione explícitamente — el barrio SIEMPRE debe quedar en blanco para que el local lo escriba y lo seleccione a mano en el formulario (así queda ligado a una ubicación real con coordenadas válidas; solo se auto-rellena cuando el contacto ya estaba guardado de una vez anterior, o cuando la dirección viene en formato calle/carrera tradicional de Centro/Norte — ej. "Cra 14 #14-23" o "Calle 14N #14-23" — en cuyo caso el sistema detecta solo si es Centro o Norte por el formato de la dirección, sin que tú tengas que preguntarlo ni pasarlo). Si la dirección es calle/carrera, pásala completa tal cual la dio el local en direccionDetalle (no la recortes). Esta herramienta NO crea ni cotiza el pedido, solo prepara y abre el formulario; el local lo completa (barrio y tiempo de alistamiento) y lo envía desde ahí mismo. Úsala también cuando el local solo dé un nombre para un tercero ya conocido, para que el formulario aparezca prellenado con lo que ya esté guardado en su libreta. Si el resultado trae "ambiguo": true, muéstrale al local los candidatos y pregúntale a cuál se refiere en vez de abrir el formulario. IMPORTANTE: esta vía rápida siempre asume que la recogida es en el local; si el local aclara que en este pedido en particular va a recoger en otro lugar, no uses esta herramienta — sigue el flujo conversacional con cotizarPedidoParaTercero y confirmarPedidoParaTercero. ESTA ES LA OPCIÓN POR DEFECTO para cualquier pedido nuevo de un tercero, incluso si ya se creó otro domicilio antes en esta misma conversación — el hecho de que haya un pedido anterior NO significa que este nuevo mensaje sea una cotización; solo cambia a cotizarPedidoParaTercero si EN ESTE MENSAJE el local dice explícitamente que ahora recoge en un lugar distinto al local.',
        parameters: {
          type: 'object',
          properties: {
            nombreCliente: { type: 'string' },
            telefonoCliente: { type: 'string' },
            direccionDetalle: { type: 'string', description: 'Manzana/casa/referencia SIN el nombre del barrio, si el mensaje ya la trae.' },
            gpsEntrega: {
              type: 'object',
              description: 'SOLO si este pedido ya se cotizó antes con cotizarPorUbicacion en este mismo mensaje/turno: pasa el mismo {lat,lng} que devolvió esa cotización, para que el formulario se abra con la dirección ya fijada por GPS (sin pedir barrio). Si el local no ha pegado un link/ubicación de Maps, no pases este campo.',
              properties: { lat: { type: 'number' }, lng: { type: 'number' } },
            },
          },
        },
      },
      {
        name: 'cotizarPorUbicacion',
        description: 'Calcula al instante la tarifa y los km de un domicilio para un TERCERO cuando el LOCAL o el CLIENTE pega un link de Google Maps o comparte una ubicación GPS como destino de entrega (en vez de dar el barrio). Úsala INMEDIATAMENTE apenas detectes un link de Google Maps (maps.app.goo.gl, goo.gl/maps, google.com/maps, o coordenadas sueltas) en el mensaje, SIN preguntar nada antes — ni de dónde recoge, ni cuánto tarda en alistarse. Si no te dicen el origen de recogida, usa origenRecogida="local" por defecto (tu dirección registrada); solo pasa "otro_lugar" si el mensaje ya aclaró que están en un sitio distinto. Responde SIEMPRE en este formato corto: confirma que quiere cotizar el domicilio, da la tarifa, y pide los datos para confirmar — ej. "¿Quieres cotizar el domicilio? Vale $X. Si quieres confirmarlo, envíame el nombre, el número de teléfono y la dirección de quien recibe." NUNCA preguntes en este paso por minutosPreparacion — eso solo se pide más adelante, cuando ya vayas a crear el pedido con iniciarPedidoParaTercero. Si después de cotizar el cliente confirma ("vale", "dale", "sí", o ya manda nombre/teléfono/dirección), llama iniciarPedidoParaTercero pasando ese mismo gpsEntrega (el que te devolvió esta función) junto con los datos que te dieron, para abrir el formulario con la dirección ya lista.',
        parameters: {
          type: 'object',
          properties: {
            urlUbicacion: { type: 'string', description: 'El link de Google Maps o el texto con las coordenadas que pegó el cliente/local, tal cual lo escribió.' },
            origenRecogida: {
              type: 'string',
              enum: ['local', 'otro_lugar'],
              description: '"local" si recoge desde su dirección registrada de siempre; "otro_lugar" solo si el mensaje ya aclaró que está en un sitio distinto ahora mismo (usa su GPS actual). Si no lo dijo, usa "local" por defecto SIN preguntar — no bloquees la cotización por esto.',
            },
          },
          required: ['urlUbicacion'],
        },
      },
      {
        name: 'cotizarPedidoParaTercero',
        description: 'Calcula la tarifa y el tiempo estimado de un domicilio que un LOCAL quiere enviarle a un tercero (uno de sus clientes), ANTES de crearlo. NO crea el pedido todavía, solo cotiza, para que el local vea precio y tiempo antes de confirmar. Úsala cuando ya tengas nombre, teléfono, la dirección exacta y cuánto tarda el pedido en estar listo. Si la dirección es manzana/casa (ciudadela), necesitas también el barrio de entrega — pregúntalo si no lo tienes. Si la dirección es calle/carrera tradicional de Centro/Norte (ej. "Cra 14 #14-23" o "Calle 14N #14-23"), NO preguntes el barrio: pasa esa dirección completa en direccionDetalle y deja barrioEntrega vacío, el sistema deduce solo si es Centro o Norte. Si buscarClienteLocalGuardado encontró varias direcciones guardadas para ese cliente, primero pregunta cuál barrio usar antes de cotizar. IMPORTANTE: ANTES de llamar esta función, en CADA pedido pregúntale al local si va a recoger en su dirección registrada/local de siempre, o si en este momento está en otro lugar — nunca lo asumas ni lo reutilices de un pedido anterior, porque el punto de recogida cambia el precio. Según la respuesta, pasa origenRecogida="local" u origenRecogida="otro_lugar". NO uses esta herramienta solo porque ya se cotizó o creó otro pedido antes en esta conversación: cada pedido nuevo para un tercero empieza por iniciarPedidoParaTercero (formulario) a menos que el local ya haya dicho en ESTE mensaje que recoge en otro lugar.',
        parameters: {
          type: 'object',
          properties: {
            nombreCliente: { type: 'string' },
            telefonoCliente: { type: 'string' },
            direccionDetalle: { type: 'string', description: 'Dirección exacta SIN el nombre del barrio: manzana/casa/referencia (ciudadela), o la dirección calle/carrera completa si es de Centro/Norte (ej. "Cra 14 #14-23", "Calle 14N #14-23").' },
            barrioEntrega: { type: 'string', description: 'Barrio de entrega. OBLIGATORIO si la dirección es manzana/casa. Déjalo vacío si la dirección es calle/carrera tradicional (Centro/Norte) — el sistema lo deduce solo del formato de la dirección.' },
            origenRecogida: {
              type: 'string',
              enum: ['local', 'otro_lugar'],
              description: '"local" si el local recoge desde su dirección registrada de siempre; "otro_lugar" si en este momento está en un sitio distinto (usa su ubicación GPS actual). Siempre hay que preguntarlo, nunca asumirlo.',
            },
            gpsEntrega: {
              type: 'object',
              description: 'Solo si el destino es una dirección YA GUARDADA de este contacto (viene en el campo "gps" de la dirección que devolvió buscarClienteLocalGuardado): pasa ese mismo {lat,lng} tal cual, para reutilizar la ubicación fija guardada en vez de recalcularla. Si es una dirección nueva (recién dada por el local), NO pases este campo.',
              properties: { lat: { type: 'number' }, lng: { type: 'number' } },
            },
            minutosPreparacion: { type: 'integer', description: 'Minutos que tarda el local en tener listo el pedido para que el repartidor lo recoja (0, 5, 10, 15, 20, 25 o 30). Si el local no lo menciona, pregúntaselo con las mismas opciones del formulario: "¿en cuánto tiempo está listo el pedido? Ya está / 5 / 10 / 15 / 20 / 25 / 30 min".' },
          },
          required: ['nombreCliente', 'telefonoCliente', 'direccionDetalle', 'origenRecogida', 'minutosPreparacion'],
        },
      },
      {
        name: 'confirmarPedidoParaTercero',
        description: 'Crea DEFINITIVAMENTE el domicilio para el tercero, después de que el local ya vio la tarifa y el tiempo (de cotizarPedidoParaTercero) y confirmó explícitamente que sí quiere enviarlo ("sí", "dale", "confirma", etc). NUNCA la uses sin haber cotizado antes y sin una confirmación explícita. Usa el MISMO origenRecogida (y el mismo gpsEntrega, si lo usaste) y el mismo minutosPreparacion que ya se usó al cotizar. Si el cliente es nuevo (buscarClienteLocalGuardado no lo encontró), antes de confirmar pregúntale si quiere guardarlo en su libreta para la próxima vez, y pasa guardarCliente=true solo si dice que sí.',
        parameters: {
          type: 'object',
          properties: {
            nombreCliente: { type: 'string' },
            telefonoCliente: { type: 'string' },
            direccionDetalle: { type: 'string', description: 'El mismo valor exacto (o corregido) usado en cotizarPedidoParaTercero.' },
            barrioEntrega: { type: 'string', description: 'El mismo barrio usado en cotizarPedidoParaTercero, si aplicaba (manzana/casa). Déjalo vacío si la dirección es calle/carrera (Centro/Norte).' },
            origenRecogida: {
              type: 'string',
              enum: ['local', 'otro_lugar'],
              description: 'El mismo valor que se usó en cotizarPedidoParaTercero para este pedido.',
            },
            gpsEntrega: {
              type: 'object',
              description: 'El mismo valor que se usó en cotizarPedidoParaTercero para este pedido, si aplicaba.',
              properties: { lat: { type: 'number' }, lng: { type: 'number' } },
            },
            minutosPreparacion: { type: 'integer', description: 'Los mismos minutos usados en cotizarPedidoParaTercero (0, 5, 10, 15, 20, 25 o 30).' },
            guardarCliente: { type: 'boolean', description: 'true solo si el local confirmó que quiere guardar este cliente en su libreta.' },
          },
          required: ['nombreCliente', 'telefonoCliente', 'direccionDetalle', 'origenRecogida', 'minutosPreparacion'],
        },
      },
      {
        name: 'guardarClienteLocalDirecto',
        description: 'Guarda DE INMEDIATO un contacto en la libreta PERSONAL de clientes del LOCAL autenticado, SIN crear ningún pedido. Úsala apenas el local pegue o escriba los datos de un tercero (nombre, teléfono y opcionalmente dirección/barrio) aunque no esté pidiendo un domicilio en ese momento — por ejemplo si pega una tarjeta de contacto, un mensaje reenviado, o dice algo como "guárdame este cliente", "anota este contacto". No esperes a que se cree un pedido para guardar el contacto: guárdalo tan pronto tengas al menos nombre y teléfono, y sigue la conversación con naturalidad (ej. preguntando para qué hora lo necesita). También puedes usarla justo antes de cotizar/confirmar un pedido para un cliente nuevo que ya confirmó que quiere que lo guardes.',
        parameters: {
          type: 'object',
          properties: {
            nombre: { type: 'string' },
            telefono: { type: 'string' },
            direccionDetalle: { type: 'string', description: 'Manzana/casa/referencia SIN el nombre del barrio, si ya la dieron.' },
            barrioEntrega: { type: 'string', description: 'Barrio, si ya lo dieron.' },
          },
          required: ['nombre', 'telefono'],
        },
      },
      {
        name: 'listarClientesLocalGuardados',
        description: 'Lista TODOS los contactos guardados en la libreta PERSONAL del LOCAL autenticado — únicamente los suyos, nunca los de otros locales (cada libreta está aislada por cuenta, es su propia base de datos privada de contactos recurrentes). Úsala cuando el local pregunte algo como "¿qué clientes tengo guardados?", "muéstrame mi libreta", "¿a quién tengo registrado?", "dime mis clientes". Esta consulta SÍ está permitida: es la información del propio local sobre su propia libreta, no datos de terceros ajenos a él, así que respóndele directamente con la lista que te devuelva la herramienta en vez de negarte.',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'borrarTodosLosContactosLocal',
        description: 'Borra PERMANENTEMENTE todos los contactos de la libreta del LOCAL autenticado. Es IRREVERSIBLE. Úsala solo cuando el local pida explícitamente borrar/eliminar TODOS sus contactos guardados (ej. "bórrame todos los contactos", "elimina mi libreta completa", "borra todos los clientes que tengo guardados"). Antes de llamarla, primero usa listarClientesLocalGuardados para saber cuántos contactos tiene, adviértele que la acción no se puede deshacer y espera que confirme explícitamente ("sí", "bórralos", "confirma"). Solo entonces llama esta función con confirmado=true. Si el local pide borrar UN SOLO contacto puntual, NO uses esta función (esa opción no existe todavía); dile que por ahora solo puedes borrar la libreta completa.',
        parameters: {
          type: 'object',
          properties: {
            confirmado: { type: 'boolean', description: 'true solo si el local ya confirmó explícitamente que quiere borrar TODOS sus contactos.' },
          },
          required: ['confirmado'],
        },
      },
    ],
  },
];

// ======================================================================
// HERRAMIENTAS GEMINI — ServiBot DEL REPARTIDOR (repartidorBotChat)
// Separadas de `herramientas` (chatbot del cliente): un repartidor NUNCA
// debe poder crear/cancelar/consultar pedidos de cliente por este chat.
// ======================================================================
const herramientasRepartidor = [
  {
    functionDeclarations: [
      {
        name: 'consultarTurno',
        description: 'Consulta si el repartidor está conectado (en turno) ahora mismo, cuántas horas lleva conectado hoy, y cuántos pedidos activos tiene. Úsala cuando pregunte por su turno, disponibilidad, o cuánto tiempo lleva trabajando hoy.',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'consultarEstadoCuenta',
        description: 'Consulta el estado de cuenta del repartidor: valor del día trabajado configurado por el admin, y el total pendiente por pagar según los días trabajados que aún no se han liquidado. Úsala cuando pregunte cuánto le deben, sus créditos, o su pago pendiente.',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'reportarProblemaPedido',
        description: 'Reporta al admin un problema con el pedido EN CURSO del repartidor (ej. el cliente no contesta, dirección incorrecta, producto incompleto, problema de acceso al lugar). Úsala solo cuando el repartidor pida explícitamente reportar/avisar un problema con su pedido actual.',
        parameters: {
          type: 'object',
          properties: {
            descripcion: { type: 'string', description: 'Resumen corto y claro (máx 150 caracteres) del problema, en base a lo que dijo el repartidor.' },
          },
          required: ['descripcion'],
        },
      },
      {
        name: 'reportarErrorApp',
        description: 'Registra un reporte técnico de un error o falla de la app (se cierra, no carga, botón no funciona, GPS no actualiza, etc.) para que el desarrollador lo revise después. Úsala cuando el repartidor describa un error o falla técnica de la app, después de darle los consejos básicos que ya conoces.',
        parameters: {
          type: 'object',
          properties: {
            descripcion: { type: 'string', description: 'Descripción del error o falla tal como la contó el repartidor, con el mayor detalle posible (qué estaba haciendo, qué pasó, mensaje de error si mencionó alguno).' },
          },
          required: ['descripcion'],
        },
      },
      {
        name: 'consultarAvisosCliente',
        description: 'Consulta los avisos urgentes más recientes que algún cliente le envió a través de su asistente de IA (ej. "se me olvidó algo", "devuélvete"). Úsala cuando el repartidor pregunte si tiene algún aviso, mensaje o instrucción pendiente de un cliente.',
        parameters: { type: 'object', properties: {} },
      },
    ],
  },
];

function buildSystemPromptRepartidor(repartidorNombre) {
  const ahora = new Date();
  const fecha = ahora.toLocaleDateString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'full' });
  const hora = ahora.toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' });

  return `Eres ServiBot, el asistente virtual para REPARTIDORES de "Servi Aliados", servicio de domicilios en Armenia, Colombia.
Le hablas al repartidor${repartidorNombre ? ` ${repartidorNombre}` : ''}. Eres amable, directo y práctico. Responde siempre en español colombiano, con respuestas cortas (esto es un chat en el celular).
Fecha y hora actual: ${fecha}, ${hora}.

IMPORTANTE: Este chat es SOLO para repartidores. No manejas pedidos de clientes, tarifas al público, ni agendas de clientes — eso es un asistente distinto. Si el repartidor pregunta algo de un cliente que no te compete, dile que ese tema lo maneja el chat de soporte o el admin.

— TU TURNO Y DISPONIBILIDAD —
Usa consultarTurno cuando pregunte si está conectado, cuánto lleva trabajando hoy, o cuántos pedidos activos tiene.

— ESTADO DE CUENTA / PAGO —
Usa consultarEstadoCuenta cuando pregunte cuánto le deben o sus créditos pendientes. El pago se calcula prorrateando el valor del día según las horas conectado (jornada de 8h), y el admin liquida manualmente.

— REPORTAR PROBLEMA CON UN PEDIDO EN CURSO —
Usa reportarProblemaPedido SOLO si pide explícitamente avisar/reportar un problema con el pedido que tiene activo ahora mismo (cliente no contesta, dirección mal, etc.). Esto le llega directo al admin.

— AVISOS DE CLIENTES —
Usa consultarAvisosCliente si pregunta si tiene algún aviso o mensaje pendiente de un cliente (ej. "¿me dejaron algún aviso?", "¿algo pendiente?").

— ERRORES O FALLAS DE LA APP (guía rápida antes de reportar) —
Si describe un problema técnico, primero intenta ayudar con estos casos conocidos:
• Grabación de audio en el chat no funciona / "no pudo iniciar el micrófono": pídele cerrar y abrir la app de nuevo, y confirmar que dio permiso de micrófono en los ajustes del celular.
• No le llegan notificaciones aunque tenga pedidos: pídele revisar que las notificaciones estén activadas en Ajustes > Apps > Servi Aliados, y que la app no esté en modo "ahorro de batería" agresivo.
• La ubicación no se actualiza o se corta en segundo plano: pídele activar "Permitir todo el tiempo" en el permiso de ubicación, y desactivar la optimización de batería para la app.
Si con eso no se resuelve, o es un error distinto, usa reportarErrorApp para dejarlo registrado.

— DUDAS GENERALES DE USO DE LA APP —
Responde con lo que sabes del funcionamiento normal de la app (pestañas: Chat, Pendientes, Asignados, Historial, Perfil, Mi Estado de Cuenta, ServiBot). Si no sabes algo con certeza, dile que pregunte al chat de soporte o al admin en vez de inventar.

— HABLAR CON UNA PERSONA / SOPORTE —
Si pide hablar con el administrador o dice que ServiBot no le está ayudando, dile que escriba al WhatsApp del encargado: 3137065977.`;
}

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

async function consultarUbicacionPedido(clienteEmail) {
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
  const repartidorUID = obtenerRepartidorUID(p);
  if (!repartidorUID) {
    return {
      encontrado: true,
      tieneRepartidor: false,
      estado: p.estado,
      mensaje: 'Tu pedido todavía no tiene repartidor asignado, así que todavía no hay ubicación en tiempo real para mostrar.',
    };
  }

  const repSnap = await admin.database().ref(`repartidores_info/${repartidorUID}`).get();
  let coords = null;
  if (repSnap.exists()) {
    const r = repSnap.val();
    if (r.ubicacionActual && r.ubicacionActual.lat && r.ubicacionActual.lng) {
      coords = { lat: r.ubicacionActual.lat, lng: r.ubicacionActual.lng };
    } else if (r.ubicacion && r.ubicacion.lat && r.ubicacion.lng) {
      coords = { lat: r.ubicacion.lat, lng: r.ubicacion.lng };
    }
  }

  return {
    encontrado: true,
    tieneRepartidor: true,
    tieneUbicacion: !!coords,
    estado: p.estado,
    repartidorNombre: p.repartidorNombre || 'Tu repartidor',
    lat: coords ? coords.lat : null,
    lng: coords ? coords.lng : null,
    mensaje: coords
      ? undefined
      : 'Tu repartidor está asignado, pero por ahora no tengo su ubicación GPS disponible.',
  };
}

async function avisarRepartidorOlvido(clienteEmail, mensajeParaRepartidor) {
  if (!clienteEmail) {
    return { enviado: false, mensaje: 'El cliente no ha iniciado sesión, no se puede avisar al repartidor.' };
  }

  const snap = await admin.database()
    .ref('pedidos_historial')
    .orderByChild('clienteEmail')
    .equalTo(clienteEmail)
    .limitToLast(5)
    .once('value');

  if (!snap.exists()) {
    return { enviado: false, mensaje: 'No encontré ningún pedido activo tuyo en este momento.' };
  }

  const pedidos = Object.entries(snap.val())
    .map(([id, p]) => ({ id, ...p }))
    .filter(p => !['entregado', 'cancelado', 'programado'].includes(p.estado))
    .sort((a, b) => (b.timestampCreacion || 0) - (a.timestampCreacion || 0));

  if (pedidos.length === 0) {
    return { enviado: false, mensaje: 'No tienes un pedido en curso en este momento, así que no hay repartidor al cual avisar.' };
  }

  const pedido = pedidos[0];
  const repartidorUID = obtenerRepartidorUID(pedido);
  if (!repartidorUID) {
    return { enviado: false, mensaje: 'Tu pedido todavía no tiene un repartidor asignado. Escribe al chat de soporte para que gestionen esto de inmediato.' };
  }

  const texto = (mensajeParaRepartidor || 'El cliente necesita avisarte algo sobre el pedido, por favor contáctalo.').slice(0, 150);
  const resultadoPush = await enviarPush(
    repartidorUID,
    '⚠️ Aviso urgente del cliente',
    texto,
    { pedidoId: pedido.id, tipo: 'aviso_cliente_devolver' }
  );

  // Queda registrado para que el ServiBot del repartidor lo pueda consultar
  // por chat (herramienta consultarAvisosCliente) y para que la app del
  // repartidor lo muestre como aviso pendiente (leido:false) aunque el push
  // no haya llegado — así no se pierde el aviso.
  await admin.database().ref(`avisos_repartidor/${repartidorUID}`).push({
    mensaje: texto,
    pedidoId: pedido.id,
    timestamp: Date.now(),
    leido: false,
  });

  if (!resultadoPush || !resultadoPush.enviado) {
    // El push no llegó (sin token FCM registrado, token vencido, etc.)
    // pero el aviso SÍ quedó guardado en avisos_repartidor para que la
    // app del repartidor lo muestre en cuanto abra o refresque.
    console.warn(`[avisarRepartidorOlvido] push no enviado a repartidor=${repartidorUID}, motivo=${resultadoPush && resultadoPush.motivo}`);
    return {
      enviado: false,
      mensaje: 'No pude confirmar que la notificación le llegó a tu repartidor en este momento (puede que no tenga la app abierta o las notificaciones activas). Ya quedó registrado el aviso para que lo vea apenas entre, pero si es urgente te recomiendo escribir también al chat de soporte.',
    };
  }

  return { enviado: true, mensaje: 'Listo, ya le avisé directamente a tu repartidor. Si no responde en unos minutos, escribe al chat de soporte.' };
}

// Se dispara cuando el repartidor toca "Entendido, ya voy" en la campana
// (ver _confirmarAvisoUrgenteBell en el index.html del repartidor, que
// escribe leido:true + confirmadoTs en este mismo nodo). Le avisa al
// cliente por su campana de notificaciones que el repartidor ya vio el
// aviso, cerrando el ciclo sin que el cliente tenga que preguntar.
exports.onAvisoRepartidorConfirmado = functions.database
  .ref('/avisos_repartidor/{repartidorUID}/{avisoKey}')
  .onUpdate(async (change, context) => {
    const before = change.before.val();
    const after = change.after.val();
    if (!after || !after.confirmadoTs) return null;
    if (before && before.confirmadoTs) return null; // ya se notificó antes

    const repartidorUID = context.params.repartidorUID;
    const pedidoId = after.pedidoId;
    if (!pedidoId) return null;

    const [nombreSnap, pedidoSnap] = await Promise.all([
      admin.database().ref(`repartidores_info/${repartidorUID}/nombre`).get(),
      admin.database().ref(`pedidos_historial/${pedidoId}`).get(),
    ]);
    if (!pedidoSnap.exists()) return null;
    const pedido = pedidoSnap.val();
    const clienteUID = obtenerClienteUID(pedido);
    if (!clienteUID) return null;

    const nombreRepartidor = nombreSnap.exists() ? nombreSnap.val() : 'Tu repartidor';
    const mensaje = `✅ ${nombreRepartidor} ya vio tu aviso y confirmó que lo está resolviendo.`;

    await admin.database().ref(`notificaciones_usuario/${clienteUID}`).push({
      titulo: '✅ Repartidor confirmó',
      mensaje,
      ts: Date.now(),
    });

    return null;
  });

// ======================================================================
// FUNCIONES AUXILIARES — ServiBot DEL REPARTIDOR (repartidorBotChat)
// ======================================================================

async function consultarTurnoRepartidor(repartidorUID) {
  const snap = await admin.database().ref(`repartidores_info/${repartidorUID}`).get();
  if (!snap.exists()) {
    return { encontrado: false, mensaje: 'No encontré tu perfil de repartidor.' };
  }
  const d = snap.val();
  const online = !!d.online;
  const trackingActivo = !!d.trackingActivo;
  const base = d.tiempoConexionBaseMs || 0;
  const enSesion = trackingActivo && d.sesionInicioActual ? (Date.now() - d.sesionInicioActual) : 0;
  const tiempoHoyMs = base + Math.max(0, enSesion);
  return {
    encontrado: true,
    online,
    trackingActivo,
    horasConectadoHoy: (tiempoHoyMs / 3600000).toFixed(1),
    pedidosActivos: d.pedidosActivos || 0,
  };
}

async function consultarEstadoCuentaRepartidor(repartidorUID) {
  const JORNADA_COMPLETA_MS = 8 * 3600000;
  const snap = await admin.database().ref(`repartidores_info/${repartidorUID}`).get();
  if (!snap.exists()) return { configurado: false, mensaje: 'No encontré tu perfil de repartidor.' };
  const perfil = snap.val();
  const valorDia = Number(perfil.valorDiaTrabajo) || 0;
  if (!valorDia) {
    return { configurado: false, mensaje: 'El administrador todavía no ha configurado tu valor de día trabajado, así que no puedo calcular tu estado de cuenta.' };
  }
  const pagadoHasta = perfil.pagadoHasta || '';
  const historial = perfil.historialConexion || {};
  const { year, month, day } = obtenerFechaBogota(0);
  const hoyStr = `${year}-${month}-${day}`;
  const base = perfil.tiempoConexionBaseMs || 0;
  const enSesion = perfil.trackingActivo && perfil.sesionInicioActual ? (Date.now() - perfil.sesionInicioActual) : 0;
  const tiempoHoyMs = base + Math.max(0, enSesion);

  const mapa = {};
  Object.values(historial).forEach(d => {
    if (d && d.fecha && d.tiempoTotalMs) mapa[d.fecha] = d.tiempoTotalMs;
  });
  if (tiempoHoyMs > 0) mapa[hoyStr] = Math.max(mapa[hoyStr] || 0, tiempoHoyMs);

  let totalPendiente = 0;
  let diasPendientes = 0;
  Object.entries(mapa).forEach(([fecha, ms]) => {
    const proporcion = Math.min(1, ms / JORNADA_COMPLETA_MS);
    const monto = proporcion * valorDia;
    const yaLiquidado = pagadoHasta && fecha <= pagadoHasta;
    if (!yaLiquidado) { totalPendiente += monto; diasPendientes += 1; }
  });

  return {
    configurado: true,
    valorDiaTrabajo: valorDia,
    totalPendiente: Math.round(totalPendiente),
    diasPendientes,
  };
}

async function reportarProblemaPedidoRepartidor(repartidorUID, repartidorNombre, descripcion) {
  const snap = await admin.database()
    .ref('pedidos_historial')
    .orderByChild('repartidorIdAsignado')
    .equalTo(repartidorUID)
    .limitToLast(5)
    .once('value');

  let pedidoActivo = null;
  if (snap.exists()) {
    const pedidos = Object.entries(snap.val())
      .map(([id, p]) => ({ id, ...p }))
      .filter(p => !['entregado', 'cancelado', 'programado'].includes(p.estado))
      .sort((a, b) => (b.timestampCreacion || 0) - (a.timestampCreacion || 0));
    pedidoActivo = pedidos[0] || null;
  }

  const texto = (descripcion || 'El repartidor reportó un problema con el pedido.').slice(0, 200);
  const key = pedidoActivo ? pedidoActivo.id : `sin_pedido_${Date.now()}`;

  await admin.database().ref(`notificaciones_admin/problema_repartidor_${key}`).set({
    titulo: '⚠️ Problema reportado por repartidor',
    mensaje: `${repartidorNombre || 'Un repartidor'}: ${texto}`,
    repartidorUID,
    pedidoId: pedidoActivo ? pedidoActivo.id : null,
    timestamp: Date.now(),
  });

  return {
    reportado: true,
    tienePedidoActivo: !!pedidoActivo,
    mensaje: pedidoActivo
      ? 'Listo, ya le avisé al admin sobre el problema con tu pedido actual.'
      : 'Listo, ya le avisé al admin. No encontré un pedido activo tuyo en este momento, pero el reporte quedó registrado igual.',
  };
}

async function reportarErrorAppRepartidor(repartidorUID, repartidorNombre, descripcion) {
  const texto = (descripcion || 'Sin detalle.').slice(0, 300);
  const ref = await admin.database().ref(`reportes_errores_app/${repartidorUID}`).push({
    repartidorNombre: repartidorNombre || 'Repartidor',
    descripcion: texto,
    timestamp: Date.now(),
  });
  return { reportado: true, id: ref.key, mensaje: 'Ya quedó registrado el reporte para que el desarrollador lo revise.' };
}

async function consultarAvisosClienteRepartidor(repartidorUID) {
  const snap = await admin.database()
    .ref(`avisos_repartidor/${repartidorUID}`)
    .orderByChild('timestamp')
    .limitToLast(3)
    .once('value');
  if (!snap.exists()) {
    return { hayAvisos: false, mensaje: 'No tienes avisos recientes de clientes.' };
  }
  const avisos = Object.values(snap.val())
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .map(a => ({ mensaje: a.mensaje, pedidoId: a.pedidoId, timestamp: a.timestamp }));
  return { hayAvisos: true, avisos };
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
  const { hora, minuto, dia, nombreEntrega, telefonoEntrega, direccionEntrega } = args || {};

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

  // ¿Ya tiene una agenda activa (sin cancelar/completar)? Si el pedido
  // vinculado ya tiene repartidor asignado (va en curso), no cortamos aquí:
  // dejamos pasar y confirmarAgendaConBarrios decide si se lo asigna
  // directo a ese mismo repartidor (o si no hay cupo, cae al flujo normal).
  const agendaExistente = await admin.database().ref(`agendas_programadas/${clienteAuthUID}`).get();
  if (agendaExistente.exists()) {
    const ae = agendaExistente.val();
    if (ae.estado === 'programada' || ae.estado === 'vinculada') {
      let pedidoActivo = null;
      if (ae.pedidoId) {
        const pSnap = await admin.database().ref(`pedidos_historial/${ae.pedidoId}`).get();
        if (pSnap.exists()) pedidoActivo = pSnap.val();
      }
      const yaVaEnCursoConRepartidor = pedidoActivo
        && ['pendiente', 'aceptado', 'en_camino'].includes(pedidoActivo.estado)
        && !!pedidoActivo.repartidorUID;

      if (!yaVaEnCursoConRepartidor) {
        return { disponible: false, mensaje: 'Ya tienes un pedido programado activo. Si quieres cambiarlo, primero pide cancelarlo.' };
      }
    }
  }

  return {
    disponible: true, hora, minuto, dia,
    nombreEntrega: nombreEntrega || null,
    telefonoEntrega: telefonoEntrega || null,
    direccionEntrega: direccionEntrega || null,
  };
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

  // ── ¿Ya tiene un pedido activo? Si ese pedido ya tiene repartidor
  //    asignado (va en curso), no bloqueamos: se intenta mandar el nuevo
  //    pedido directo a ese mismo repartidor (si tiene cupo) en vez de
  //    hacer esperar al cliente a que termine o cancele el anterior. ──
  const ESTADOS_EN_CURSO = ['pendiente', 'aceptado', 'en_camino'];
  let repartidorMismoUID = null;
  let repartidorMismoNombre = null;

  const agendaExistente = await admin.database().ref(`agendas_programadas/${clienteAuthUID}`).get();
  if (agendaExistente.exists()) {
    const ae = agendaExistente.val();
    if (ae.estado === 'programada' || ae.estado === 'vinculada') {
      let pedidoActivo = null;
      if (ae.pedidoId) {
        const pSnap = await admin.database().ref(`pedidos_historial/${ae.pedidoId}`).get();
        if (pSnap.exists()) pedidoActivo = pSnap.val();
      }

      if (pedidoActivo && ESTADOS_EN_CURSO.includes(pedidoActivo.estado) && pedidoActivo.repartidorUID) {
        // Ya va en curso con repartidor asignado → candidato a "mismo repartidor"
        repartidorMismoUID = pedidoActivo.repartidorUID;
        repartidorMismoNombre = pedidoActivo.repartidorNombre || 'Repartidor';
      } else if (!pedidoActivo || pedidoActivo.estado === 'programado' || ESTADOS_EN_CURSO.includes(pedidoActivo.estado)) {
        // Sigue esperando asignación (o no encontramos el pedido, por seguridad
        // asumimos que sigue activo): mismo bloqueo que antes.
        return { agendado: false, mensaje: 'Ya tienes un pedido programado activo.' };
      }
      // Si el pedido vinculado ya está entregado/cancelado, seguimos de
      // largo como si no hubiera agenda activa.
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
    const km = await calcularDistanciaRutaKm(coordsRec, coordsEnt);
    montoTotal = precioSegunKm(km);
    if (montoTotal === null) {
      requiereMapeador = true;
      razonPrecio = `Fuera del rango de cobertura automática (${km.toFixed(1)} km); requiere confirmar precio manualmente`;
    } else {
      razonPrecio = `Estimado automáticamente por distancia (${km.toFixed(1)} km)`;
    }
  } else {
    requiereMapeador = true;
    razonPrecio = 'No se pudo ubicar automáticamente una de las direcciones; falta confirmar en el mapa';
  }

  let clienteNombre = 'Cliente';
  const uSnap = await admin.database().ref(`usuarios/${clienteAuthUID}`).get();
  if (uSnap.exists()) clienteNombre = uSnap.val().nombre || 'Cliente';

  const codigoEntrega = String(Math.floor(1000 + Math.random() * 9000));

  // ── Si hay candidato a "mismo repartidor", intentar reservarle cupo
  //    (mismo tope de 3 pedidos activos que usa la asignación automática).
  //    Si no hay cupo, sigue el flujo normal (queda "programado"). ──
  let asignacionInmediata = false;
  if (repartidorMismoUID) {
    const cupoRef = admin.database().ref(`repartidores_info/${repartidorMismoUID}/pedidosActivos`);
    const tx = await cupoRef.transaction(actual => {
      if ((actual || 0) >= 3) return actual; // sin cupo, aborta
      return (actual || 0) + 1;
    });
    if (tx.committed) asignacionInmediata = true;
  }

  const pedidoData = {
    tipo: 'domicilio_chatbot',
    estado: asignacionInmediata ? 'pendiente' : 'programado',
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
    repartidorUID: asignacionInmediata ? repartidorMismoUID : null,
    repartidorNombre: asignacionInmediata ? repartidorMismoNombre : 'Sin asignar',
    timestampCreacion: ahora,
    timestampAsignacion: asignacionInmediata ? ahora : null,
    fecha: new Date().toISOString(),
  };

  const nuevoPedido = await admin.database().ref('pedidos_historial').push(pedidoData);
  const pedidoId = nuevoPedido.key;

  if (asignacionInmediata) {
    // Va directo al mismo repartidor que ya tiene en curso: no pasa por
    // agendas_programadas (esa agenda sigue apuntando al pedido original).
    await admin.database().ref(`pedidos_pendientes/${pedidoId}`).set({ ...pedidoData, pedidoId, historialId: pedidoId });

    // FIX (igual que en asignarPedidosProgramados): sin esto no aparece en
    // la pantalla del repartidor, que solo escucha repartidores_pedidos/{uid}.
    await admin.database().ref(`repartidores_pedidos/${repartidorMismoUID}/${pedidoId}`).set({ ...pedidoData, pedidoId });

    await enviarPush(
      repartidorMismoUID,
      'Nuevo pedido asignado',
      'El cliente que ya llevas en curso pidió otro domicilio.',
      { pedidoId, tipo: 'pedido_mismo_repartidor' }
    );
  } else {
    await admin.database().ref(`agendas_programadas/${clienteAuthUID}`).set({
      horaProgramada: timestampAgenda,
      estado: 'vinculada',
      pedidoId,
      creadoEn: ahora,
      clienteEmail: clienteEmail || null,
    });
  }

  const horaTexto = new Date(timestampAgenda).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' });

  return {
    agendado: true,
    pedidoId,
    horaProgramada: horaTexto,
    montoEstimado: montoTotal,
    requiereMapeador,
    mensaje: asignacionInmediata
      ? `¡Listo! Como ya tienes a ${repartidorMismoNombre} en camino, le asigné directo este pedido también. Recogida: ${dirRecogidaTexto}. Entrega: ${direccionEntrega}, para ${nombreRecibe}. Tarifa estimada: $${(montoTotal || 0).toLocaleString('es-CO')}.`
      : requiereMapeador
      ? `Tu pedido quedó agendado para las ${horaTexto}, pero no pude calcular el precio exacto automáticamente; el valor queda pendiente de confirmar.`
      : `¡Listo! Tu pedido se ha programado con éxito para las ${horaTexto}. Recogida: ${dirRecogidaTexto}. Entrega: ${direccionEntrega}, para ${nombreRecibe}. Tarifa estimada: $${montoTotal.toLocaleString('es-CO')}.`,
  };
}

// ======================================================================
// LIBRETA DE CLIENTES DEL LOCAL — para que un LOCAL (comerciante) pueda
// pedirle domicilios a ServiBot PARA UN TERCERO (su propio cliente), sin
// tener que volver a escribir dirección/barrio cada vez que ese tercero
// vuelve a pedir. Se guarda en clientesGuardadosLocal/{clienteAuthUID}/{telKey}
// ======================================================================
function normalizarTelefono(tel) {
  return (tel || '').toString().replace(/\D/g, '');
}
function normalizarBarrioKey(barrio) {
  return (barrio || '').toString().trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // sin tildes
    .replace(/\s+/g, '_');
}
// Normaliza nombres para comparar sin importar tildes, mayúsculas o espacios
// dobles (ej. "José Luis" === "jose  luis" === "JOSE LUIS").
function normalizarNombre(nombre) {
  return (nombre || '').toString().trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

async function buscarClienteLocalGuardado(clienteAuthUID, { nombre, telefono } = {}) {
  if (!clienteAuthUID) return { encontrado: false, mensaje: 'No hay sesión activa.' };
  const snap = await admin.database().ref(`clientesGuardadosLocal/${clienteAuthUID}`).get();
  if (!snap.exists()) return { encontrado: false };
  const todos = snap.val();

  // 1) Búsqueda por teléfono: exacta y prioritaria, porque el teléfono ES
  // la llave del registro (normalizarTelefono), así que no hay ambigüedad.
  if (telefono) {
    const key = normalizarTelefono(telefono);
    if (todos[key]) {
      const match = todos[key];
      const direcciones = match.direcciones ? Object.values(match.direcciones) : [];
      return { encontrado: true, nombre: match.nombre, telefono: match.telefono, direcciones };
    }
  }

  // 2) Búsqueda por nombre: tolerante a tildes/mayúsculas/espacios. Primero
  // intenta coincidencia EXACTA (nombre completo igual). Si no hay exacta,
  // busca coincidencias PARCIALES (ej. "Camilo" encuentra "Camilo Pérez").
  // Si hay más de una coincidencia parcial, NO se adivina ni se mezcla con
  // otro contacto: se devuelven los candidatos para que ServiBot pregunte
  // cuál es, en vez de tomar el primero que encuentre (o mezclar datos).
  if (nombre) {
    const nombreBuscado = normalizarNombre(nombre);
    const lista = Object.values(todos);

    const exacto = lista.find(c => normalizarNombre(c.nombre) === nombreBuscado);
    if (exacto) {
      const direcciones = exacto.direcciones ? Object.values(exacto.direcciones) : [];
      return { encontrado: true, nombre: exacto.nombre, telefono: exacto.telefono, direcciones };
    }

    const parciales = lista.filter(c => {
      const nombreGuardado = normalizarNombre(c.nombre);
      return nombreGuardado.includes(nombreBuscado) || nombreBuscado.includes(nombreGuardado);
    });

    if (parciales.length === 1) {
      const match = parciales[0];
      const direcciones = match.direcciones ? Object.values(match.direcciones) : [];
      return { encontrado: true, nombre: match.nombre, telefono: match.telefono, direcciones };
    }

    if (parciales.length > 1) {
      return {
        encontrado: false,
        ambiguo: true,
        mensaje: `Encontré varios contactos parecidos a "${nombre}", pregúntale al local cuál es antes de continuar.`,
        candidatos: parciales.map(c => ({
          nombre: c.nombre,
          telefono: c.telefono,
          direcciones: c.direcciones ? Object.values(c.direcciones) : [],
        })),
      };
    }
  }

  return { encontrado: false };
}

// Guarda (o actualiza) un contacto en la libreta del LOCAL de inmediato,
// SIN crear ningún pedido. Esto es lo que permite que, al pegar los datos
// de un tercero en el chat, ServiBot lo recuerde para la próxima vez aunque
// no se esté pidiendo un domicilio en ese momento.
async function guardarClienteLocalDirecto(clienteAuthUID, args) {
  if (!clienteAuthUID) return { guardado: false, mensaje: 'No hay sesión activa.' };
  const { nombre, telefono, direccionDetalle, barrioEntrega } = args || {};
  if (!nombre || !telefono) {
    return { guardado: false, mensaje: 'Necesito al menos el nombre y el teléfono del contacto para guardarlo.' };
  }
  const key = normalizarTelefono(telefono);
  if (!key) {
    return { guardado: false, mensaje: 'Ese teléfono no parece válido, dame un número de teléfono correcto.' };
  }

  let gpsDireccion = null;
  if (direccionDetalle && barrioEntrega) {
    const valido = await barrioRegistrado(barrioEntrega);
    if (!valido) {
      return {
        guardado: false,
        mensaje: `El cliente no fue guardado porque la ubicación "${barrioEntrega}" no está en nuestros registros. Comunícate con el asesor para que registren esa ubicación.`,
      };
    }
    // FIX: adjuntar de una vez la ubicación (lat/lng) del barrio al guardar,
    // en vez de solo guardar el nombre en texto. Así el contacto queda
    // registrado con su ubicación fija desde ahora, y no hay que volver a
    // buscarla en la lista de barrios cada vez que le pidan un domicilio.
    gpsDireccion = await resolverCoordsBarrio(barrioEntrega);
  }

  const datos = {
    nombre,
    telefono,
    ultimaActualizacion: Date.now(),
  };
  if (direccionDetalle && barrioEntrega) {
    const barrioKey = normalizarBarrioKey(barrioEntrega);
    datos[`direcciones/${barrioKey}`] = {
      barrio: barrioEntrega,
      detalle: direccionDetalle,
      gps: gpsDireccion ? { lat: gpsDireccion.lat, lng: gpsDireccion.lng } : null,
    };
  }

  await admin.database().ref(`clientesGuardadosLocal/${clienteAuthUID}/${key}`).update(datos);
  return { guardado: true, mensaje: `Listo, guardé a ${nombre} en tu libreta de clientes.` };
}

// Lista TODOS los contactos guardados en la libreta del LOCAL autenticado.
// Está naturalmente aislado por clienteAuthUID: cada local solo puede leer
// su propio nodo, nunca el de otro local.
async function listarClientesLocalGuardados(clienteAuthUID) {
  if (!clienteAuthUID) return { encontrado: false, mensaje: 'No hay sesión activa.' };
  const snap = await admin.database().ref(`clientesGuardadosLocal/${clienteAuthUID}`).get();
  if (!snap.exists()) return { encontrado: true, total: 0, clientes: [] };
  const todos = snap.val();
  const clientes = Object.values(todos).map(c => ({
    nombre: c.nombre,
    telefono: c.telefono,
    direcciones: c.direcciones ? Object.values(c.direcciones) : [],
  }));
  return { encontrado: true, total: clientes.length, clientes };
}

// Borra PERMANENTEMENTE toda la libreta de contactos del LOCAL autenticado.
// Requiere confirmado=true para ejecutarse (la confirmación explícita del
// local ya la debe haber pedido ServiBot en el chat antes de llamar esto).
async function borrarTodosLosContactosLocal(clienteAuthUID, args) {
  if (!clienteAuthUID) return { borrado: false, mensaje: 'No hay sesión activa.' };
  if (!args || args.confirmado !== true) {
    return { borrado: false, mensaje: 'No se borró nada: falta la confirmación explícita del local antes de ejecutar esta acción irreversible.' };
  }
  const ref = admin.database().ref(`clientesGuardadosLocal/${clienteAuthUID}`);
  const snap = await ref.get();
  const total = snap.exists() ? Object.keys(snap.val()).length : 0;
  if (total === 0) {
    return { borrado: true, total: 0, mensaje: 'Tu libreta ya estaba vacía, no había contactos guardados para borrar.' };
  }
  await ref.remove();
  return { borrado: true, total, mensaje: `Listo, borré los ${total} contacto(s) de tu libreta. Esta acción no se puede deshacer.` };
}

// Busca, entre los repartidores en línea, el más conveniente para estimar
// tiempo (el más cercano al punto de recogida, penalizando por cada pedido
// que ya tenga en ruta — mismo criterio que usa asignarPedidosProgramados).
async function estimarTiempoYRepartidor(coordsRecogida) {
  const repSnap = await admin.database().ref('repartidores_info').get();
  if (!repSnap.exists()) return { minEstimado: null, pedidosEnRuta: null };
  const disponibles = Object.values(repSnap.val())
    .filter(r => r.online === true && r.ubicacionActual && r.ubicacionActual.lat);
  if (disponibles.length === 0) return { minEstimado: null, pedidosEnRuta: null };

  const velocidadMs = 25000 / 3600; // 25 km/h
  const candidatos = disponibles.map(r => {
    const distKm = coordsRecogida ? calcularDistanciaKm(r.ubicacionActual, coordsRecogida) : 999;
    const pedidosEnRuta = r.pedidosActivos || 0;
    const minBase = Math.max(1, Math.ceil((distKm * 1000) / velocidadMs / 60));
    // +8 min estimados por cada pedido que ya lleve en ruta
    const minEstimado = minBase + (pedidosEnRuta * 8);
    return { distKm, pedidosEnRuta, minEstimado };
  }).sort((a, b) => a.minEstimado - b.minEstimado);

  return { minEstimado: candidatos[0].minEstimado, pedidosEnRuta: candidatos[0].pedidosEnRuta };
}

// Resuelve las coordenadas de recogida = de dónde va a salir el pedido.
// FIX: no todos los "locales" tienen un sitio fijo — hay negocios con
// dirección fija (tienda, restaurante) y hay vendedores que se mueven todo
// el día. Por eso ya NO se adivina la fuente: ServiBot le pregunta al local,
// en cada pedido para tercero, si recoge en su dirección registrada o en
// otro lugar en este momento, y ese origen se pasa explícito aquí:
//   - 'local'      -> usa SIEMPRE la dirección registrada del negocio (fija,
//                      estable, misma tarifa siempre que pida desde ahí).
//   - 'otro_lugar' -> usa el GPS en vivo del celular (debe estar fresco,
//                      <30 min). Si no hay GPS reciente, usa gpsManual si el
//                      local lo marcó en el mapeador del formulario; si
//                      tampoco hay eso, NO se cae en silencio a la dirección
//                      registrada (sería justo el bug reportado) — se marca
//                      para que un administrador lo confirme manualmente.
async function resolverCoordsLocal(clienteAuthUID, origen = 'local', gpsManual = null) {
  if (origen === 'otro_lugar') {
    const liveSnap = await admin.database().ref(`ubicaciones_clientes/${clienteAuthUID}`).get();
    if (liveSnap.exists()) {
      const live = liveSnap.val();
      if (live.lat && live.lng && (Date.now() - (live.ts || 0)) / 60000 < 30) {
        return { lat: live.lat, lng: live.lng };
      }
    }
    if (gpsManual && gpsManual.lat && gpsManual.lng) {
      return { lat: parseFloat(gpsManual.lat), lng: parseFloat(gpsManual.lng) };
    }
    return null; // GPS no disponible o viejo, y tampoco se marcó en el mapa: que lo confirme un administrador.
  }

  // origen === 'local' (o no especificado): dirección registrada, fija.
  let coords = null;
  const regSnap = await admin.database().ref(`usuarios/${clienteAuthUID}/ubicacionRegistro`).get();
  if (regSnap.exists()) {
    const reg = regSnap.val();
    if (reg.lat && reg.lat !== 'N/A' && (reg.lon || reg.lng)) {
      coords = { lat: parseFloat(reg.lat), lng: parseFloat(reg.lon || reg.lng) };
    }
  }
  if (!coords) {
    const dirSnap = await admin.database().ref(`usuarios/${clienteAuthUID}/direccion`).get();
    if (dirSnap.exists() && dirSnap.val()) {
      coords = await geocodificarTexto(dirSnap.val());
    }
  }
  return coords;
}

// Cotiza un domicilio para tercero cuando el local pega un link de Google
// Maps o comparte ubicación GPS como destino, en vez de dar el barrio.
// Reutiliza calcularDistanciaKm y precioSegunKm tal cual ya existen.
async function cotizarPorUbicacion(clienteAuthUID, args) {
  if (!clienteAuthUID) return { cotizado: false, mensaje: 'No hay sesión activa.' };
  const { urlUbicacion, origenRecogida } = args || {};
  if (!urlUbicacion) {
    return { cotizado: false, mensaje: 'No encontré ningún link de Google Maps ni coordenadas. Pídele al cliente que reenvíe la ubicación.' };
  }

  const coordsEnt = await extraerCoordsDeTextoUbicacion(urlUbicacion);
  if (!coordsEnt) {
    return { cotizado: false, mensaje: 'No pude leer coordenadas de ese link. Pídele al cliente que reenvíe la ubicación (compartir ubicación desde Google Maps).' };
  }

  const coordsRec = await resolverCoordsLocal(clienteAuthUID, origenRecogida || 'local');
  if (!coordsRec) {
    return {
      cotizado: false,
      mensaje: origenRecogida === 'otro_lugar'
        ? 'No pude tomar tu ubicación GPS actual. Abre la app un momento para actualizarla y vuelve a intentar.'
        : 'No tengo una dirección de recogida registrada para calcular la distancia.',
    };
  }

  const km = await calcularDistanciaRutaKm(coordsRec, coordsEnt);
  const montoTotal = precioSegunKm(km);

  if (montoTotal === null) {
    return {
      cotizado: false,
      fueraDeCobertura: true,
      km: Number(km.toFixed(1)),
      mensaje: `Esa ubicación queda a ${km.toFixed(1)} km, fuera del rango de cobertura automática (máximo 30 km). Dile al cliente que un administrador debe confirmar el precio manualmente.`,
    };
  }

  return {
    cotizado: true,
    km: Number(km.toFixed(1)),
    montoEstimado: montoTotal,
    gpsEntrega: { lat: coordsEnt.lat, lng: coordsEnt.lng },
    mensaje: `La entrega queda a ${km.toFixed(1)} km. Tarifa estimada: $${montoTotal.toLocaleString('es-CO')}.`,
  };
}

// Prepara los datos para el formulario rápido de "pedido para tercero": si
// el local ya tiene guardado a ese contacto (por teléfono o nombre), completa
// barrio y dirección con lo que ya esté guardado; si no, deja que el
// formulario los pida vacíos (el barrio siempre se confirma a mano).
async function iniciarPedidoParaTercero(clienteAuthUID, args) {
  if (!clienteAuthUID) return { disponible: false, mensaje: 'No hay sesión activa.' };
  const { nombreCliente, telefonoCliente, direccionDetalle, gpsEntrega } = args || {};
  if (!nombreCliente && !telefonoCliente) {
    return { disponible: false, mensaje: 'Necesito al menos el nombre o el teléfono del cliente para abrir el formulario.' };
  }

  // Vino de cotizarPorUbicacion (link/ubicación GPS pegado por el local): la
  // dirección ya está fijada por coordenadas exactas, no hace falta barrio.
  if (gpsEntrega && gpsEntrega.lat && gpsEntrega.lng) {
    return {
      disponible: true,
      esContactoNuevo: true,
      nombreCliente: nombreCliente || '',
      telefonoCliente: telefonoCliente || '',
      direccionDetalle: 'Ubicación GPS',
      barrioEntrega: '',
      gpsEntrega: { lat: gpsEntrega.lat, lng: gpsEntrega.lng },
    };
  }

  const busqueda = await buscarClienteLocalGuardado(clienteAuthUID, { nombre: nombreCliente, telefono: telefonoCliente });
  if (busqueda.ambiguo) {
    return { disponible: false, ambiguo: true, candidatos: busqueda.candidatos, mensaje: busqueda.mensaje };
  }

  let nombreFinal = nombreCliente || '';
  let telefonoFinal = telefonoCliente || '';
  let direccionFinal = direccionDetalle || '';
  // El barrio NUNCA se prellena con un texto suelto/adivinado del mensaje del
  // local (aunque el mensaje lo mencione): siempre debe pasar por el buscador
  // de barrios reales del formulario, para garantizar que corresponda a una
  // ubicación registrada con coordenadas válidas. Solo se prellena cuando el
  // contacto YA estaba guardado con una única dirección ya confirmada antes.
  let barrioFinal = '';

  if (busqueda.encontrado) {
    nombreFinal = nombreFinal || busqueda.nombre;
    telefonoFinal = telefonoFinal || busqueda.telefono;
    // Solo autocompleta la dirección guardada si el local no dio una nueva
    // Y ese contacto tiene una única dirección guardada (si tiene varias,
    // no se adivina cuál usar: se deja vacía para que la escriba de nuevo).
    if (!direccionFinal && busqueda.direcciones && busqueda.direcciones.length === 1) {
      barrioFinal = busqueda.direcciones[0].barrio || '';
      direccionFinal = busqueda.direcciones[0].detalle || '';
    }
  }

  // Excepción a la regla de "barrio siempre en blanco": si la dirección viene
  // en formato tradicional calle/carrera (Centro/Norte), sí se puede saber la
  // zona con certeza sin necesidad de que el local la escoja a mano.
  if (!barrioFinal && direccionFinal) {
    const cc = extraerDireccionCalleCarrera(direccionFinal);
    if (cc) {
      barrioFinal = cc.zona;
      direccionFinal = cc.direccionDetalle;
    }
  }

  return {
    disponible: true,
    esContactoNuevo: !busqueda.encontrado,
    nombreCliente: nombreFinal,
    telefonoCliente: telefonoFinal,
    direccionDetalle: direccionFinal,
    barrioEntrega: barrioFinal,
  };
}

async function cotizarPedidoParaTercero(clienteAuthUID, args) {
  if (!clienteAuthUID) return { cotizado: false, mensaje: 'No hay sesión activa.' };
  const { nombreCliente, telefonoCliente, origenRecogida, gpsEntrega, minutosPreparacion } = args || {};
  let { direccionDetalle, barrioEntrega } = args || {};
  // Si no vino barrio pero la dirección es formato calle/carrera (Centro/Norte),
  // se deduce solo — no hace falta que el local lo diga ni que se le pregunte.
  if (!barrioEntrega && direccionDetalle) {
    const cc = extraerDireccionCalleCarrera(direccionDetalle);
    if (cc) {
      barrioEntrega = cc.zona;
      direccionDetalle = cc.direccionDetalle;
    }
  }
  const tieneGpsEntrega = !!(gpsEntrega && gpsEntrega.lat && gpsEntrega.lng);
  if (!nombreCliente || !telefonoCliente || !direccionDetalle || (!barrioEntrega && !tieneGpsEntrega) || !origenRecogida) {
    return { cotizado: false, mensaje: 'Faltan datos: nombre, teléfono, dirección exacta, barrio de entrega (o ubicación GPS), o si recoge en el local o en otro lugar.' };
  }
  if (!barrioEntrega && tieneGpsEntrega) barrioEntrega = 'Ubicación GPS';
  if (minutosPreparacion === undefined || minutosPreparacion === null || minutosPreparacion === '') {
    return { cotizado: false, faltaTiempoPreparacion: true, mensaje: 'Antes de cotizar, pregúntale al local en cuánto tiempo está listo el pedido para que el repartidor lo recoja: "Ya está / 5 / 10 / 15 / 20 / 25 / 30 minutos".' };
  }
  const prepMin = Number(minutosPreparacion) || 0;

  const coordsRec = await resolverCoordsLocal(clienteAuthUID, origenRecogida);
  const coordsEnt = (gpsEntrega && gpsEntrega.lat && gpsEntrega.lng)
    ? gpsEntrega
    : await resolverCoordsBarrio(barrioEntrega);

  let montoTotal = null;
  let requiereMapeador = false;
  if (coordsRec && coordsEnt) {
    const km = await calcularDistanciaRutaKm(coordsRec, coordsEnt);
    montoTotal = precioSegunKm(km);
    if (montoTotal === null) requiereMapeador = true;
  } else {
    requiereMapeador = true;
  }

  let avisoGps = null;
  if (!coordsRec && origenRecogida === 'otro_lugar') {
    avisoGps = 'No se pudo tomar tu ubicación GPS actual (puede estar desactualizada). Dile al local que abra la app un momento para actualizar su ubicación antes de confirmar, o el precio se ajustará manualmente.';
  }

  const { minEstimado, pedidosEnRuta } = await estimarTiempoYRepartidor(coordsRec);
  let tiempoTexto = 'aún no hay repartidores disponibles para estimar el tiempo';
  if (minEstimado !== null) {
    const desde = minEstimado + prepMin;
    const hasta = minEstimado + prepMin + 5;
    const notaPrep = prepMin > 0 ? `, incluyendo los ${prepMin} min que dijiste que tarda en alistarse` : '';
    tiempoTexto = pedidosEnRuta > 0
      ? `${desde}-${hasta} minutos${notaPrep} (el repartidor más cercano lleva ${pedidosEnRuta} pedido(s) en ruta)`
      : `${desde}-${hasta} minutos${notaPrep} (repartidor disponible, va directo)`;
  }

  return {
    cotizado: true,
    montoEstimado: montoTotal,
    requiereMapeador,
    avisoGps,
    tiempoEstimadoTexto: tiempoTexto,
    resumen: `Entrega para ${nombreCliente} en ${barrioEntrega}, ${direccionDetalle}. Tarifa: ${montoTotal ? '$' + montoTotal.toLocaleString('es-CO') : 'a confirmar'}. Tiempo estimado: ${tiempoTexto}.`,
  };
}

async function confirmarPedidoParaTercero(clienteAuthUID, clienteEmail, args) {
  if (!clienteAuthUID) return { confirmado: false, mensaje: 'No hay sesión activa.' };
  const { nombreCliente, telefonoCliente, origenRecogida, gpsEntrega, gpsRecogidaManual, minutosPreparacion, guardarCliente } = args || {};
  let { direccionDetalle, barrioEntrega } = args || {};
  // Misma deducción que en cotizarPedidoParaTercero: si falta el barrio pero
  // la dirección es calle/carrera, se deduce Centro/Norte automáticamente.
  if (!barrioEntrega && direccionDetalle) {
    const cc = extraerDireccionCalleCarrera(direccionDetalle);
    if (cc) {
      barrioEntrega = cc.zona;
      direccionDetalle = cc.direccionDetalle;
    }
  }
  const tieneGpsEntrega = !!(gpsEntrega && gpsEntrega.lat && gpsEntrega.lng);
  if (!nombreCliente || !telefonoCliente || !direccionDetalle || (!barrioEntrega && !tieneGpsEntrega) || !origenRecogida) {
    return { confirmado: false, mensaje: 'Faltan datos para confirmar el pedido.' };
  }
  if (!barrioEntrega && tieneGpsEntrega) barrioEntrega = 'Ubicación GPS';
  if (minutosPreparacion === undefined || minutosPreparacion === null || minutosPreparacion === '') {
    return { confirmado: false, faltaTiempoPreparacion: true, mensaje: 'Antes de confirmar, pregúntale al local en cuánto tiempo está listo el pedido: "Ya está / 5 / 10 / 15 / 20 / 25 / 30 minutos".' };
  }
  const prepMin = Number(minutosPreparacion) || 0;

  const coordsRec = await resolverCoordsLocal(clienteAuthUID, origenRecogida, gpsRecogidaManual);
  const coordsEnt = (gpsEntrega && gpsEntrega.lat && gpsEntrega.lng)
    ? gpsEntrega
    : await resolverCoordsBarrio(barrioEntrega);

  let montoTotal = null;
  let razonPrecio = 'Pendiente de confirmar por el administrador';
  let requiereMapeador = false;
  if (coordsRec && coordsEnt) {
    const km = await calcularDistanciaRutaKm(coordsRec, coordsEnt);
    montoTotal = precioSegunKm(km);
    if (montoTotal === null) {
      requiereMapeador = true;
      razonPrecio = `Fuera del rango de cobertura automática (${km.toFixed(1)} km); requiere confirmar precio manualmente`;
    } else {
      razonPrecio = `Estimado automáticamente por distancia (${km.toFixed(1)} km)`;
    }
  } else {
    requiereMapeador = true;
    razonPrecio = 'No se pudo ubicar automáticamente una de las direcciones; falta confirmar en el mapa';
  }

  let localNombre = 'Local';
  const uSnap = await admin.database().ref(`usuarios/${clienteAuthUID}`).get();
  if (uSnap.exists()) localNombre = uSnap.val().nombre || 'Local';

  const codigoEntrega = String(Math.floor(1000 + Math.random() * 9000));
  const ahora = Date.now();

  const pedidoData = {
    tipo: 'domicilio_local_tercero',
    estado: 'pendiente',
    codigoEntrega,
    dirRecogida: origenRecogida === 'otro_lugar' ? `${localNombre} (recogida en otro lugar, no en el local)` : `${localNombre} (recogida en el local)`,
    origenRecogida,
    gpsRecogida: coordsRec ? { lat: coordsRec.lat, lng: coordsRec.lng } : null,
    direccionCliente: `${barrioEntrega}, ${direccionDetalle}`,
    nombreRecibe: nombreCliente,
    telefonoCliente,
    barrioEntrega,
    gpsDestino: coordsEnt ? { lat: coordsEnt.lat, lng: coordsEnt.lng } : null,
    montoTotal,
    montoOriginal: montoTotal,
    razonPrecio,
    requiereMapeador,
    // Mismo campo que usa el formulario normal ("¿En cuánto tiempo está listo
    // el pedido?"), para que el cliente final vea la misma explicación de
    // demora por cocina en su pantalla de seguimiento.
    tiempoRecogidaMin: prepMin,
    tiempoRecogidaTexto: etiquetaTiempoPreparacion(prepMin),
    descripcion: `Domicilio de ${localNombre} para ${nombreCliente} (vía ServiBot)`,
    clienteIdAsignado: clienteAuthUID,
    clienteNombre: localNombre,
    clienteEmail: clienteEmail || null,
    repartidorUID: null,
    repartidorNombre: 'Sin asignar',
    timestampCreacion: ahora,
    fecha: new Date().toISOString(),
  };

  const nuevoPedido = await admin.database().ref('pedidos_historial').push(pedidoData);
  const pedidoId = nuevoPedido.key;
  await admin.database().ref(`pedidos_pendientes/${pedidoId}`).set({ ...pedidoData, pedidoId, historialId: pedidoId });

  if (guardarCliente) {
    const key = normalizarTelefono(telefonoCliente);
    const barrioKey = normalizarBarrioKey(barrioEntrega);
    await admin.database().ref(`clientesGuardadosLocal/${clienteAuthUID}/${key}`).update({
      nombre: nombreCliente,
      telefono: telefonoCliente,
      ultimoPedido: ahora,
      [`direcciones/${barrioKey}`]: { barrio: barrioEntrega, detalle: direccionDetalle },
    });
    await admin.database().ref(`clientesGuardadosLocal/${clienteAuthUID}/${key}/vecesPedido`).transaction(v => (v || 0) + 1);
  }

  return {
    confirmado: true,
    pedidoId,
    codigoEntrega,
    mensaje: `¡Listo! Domicilio creado para ${nombreCliente} en ${barrioEntrega}${prepMin > 0 ? ` (recogida en ${prepMin} min)` : ''}. Tarifa: ${montoTotal ? '$' + montoTotal.toLocaleString('es-CO') : 'a confirmar'}. Buscando repartidor disponible...`,
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

— VACANTES / TRABAJAR COMO REPARTIDOR —
Si preguntan si hay vacantes, cómo ser repartidor, o cómo trabajar en Servi Aliados, dile que escriba
directamente al WhatsApp 3137065977 para que le den la información y el proceso de vinculación.
No des detalles de requisitos ni pagos porque no los tienes confirmados.

— AVISAR ALGO AL REPARTIDOR EN CURSO —
Si el cliente dice que se le olvidó algo, que el repartidor se fue sin el pedido completo, o pide
que le avises al repartidor sobre su pedido EN CURSO (no programado), usa la herramienta
avisarRepartidorOlvido con un resumen corto y claro de la situación. Esto le manda una notificación
urgente directa al repartidor, así el cliente no tiene que llamar a soporte. Si la herramienta indica
que no hay repartidor asignado o no hay pedido activo, explícaselo y ofrece el chat de soporte.

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
Si el cliente quiere agendar, necesitas al menos la hora exacta (hora, minuto, hoy o mañana) y
llamas a iniciarAgendaProgramada. NUNCA preguntes proactivamente por el barrio (eso SIEMPRE se
selecciona manualmente en el formulario). Tampoco preguntes proactivamente por nombre, teléfono
o dirección exacta si el cliente no los ha dado. PERO si el cliente ya mencionó en su mensaje el
nombre de quien recibe, su teléfono, y/o la dirección exacta (manzana/casa/referencia, sin
barrio), extráelos tal cual y pásalos en los argumentos nombreEntrega, telefonoEntrega y
direccionEntrega para que el formulario se abra ya pre-llenado con esos datos — así el cliente
solo tiene que buscar y seleccionar el barrio. Si la hora no es válida o ya tiene agenda activa,
explícalo con claridad. Si es válida, dile brevemente que complete lo que falte (como mínimo el
barrio) en el formulario que se acaba de abrir.
EXCEPCIÓN: si el cliente ya tiene un pedido EN CURSO (con repartidor asignado, yendo hacia allá),
sí puede pedir otro — el sistema intenta asignárselo directo al mismo repartidor que ya tiene, sin
que tenga que esperar a que termine el primero. No le digas que debe esperar solo por tener un
pedido activo; deja que la herramienta te confirme si es posible.
Si el cliente pide cancelar, usa cancelarPedidoProgramado. Si la respuesta indica que ya tiene
repartidor asignado, explícale que ya no se puede cancelar por chat y que debe escribir al chat
de soporte.

— LINK O UBICACIÓN DE GOOGLE MAPS PEGADA EN EL CHAT —
En cuanto el mensaje del cliente contenga un link de Google Maps (maps.app.goo.gl, goo.gl/maps,
google.com/maps) o texto de coordenadas sueltas — venga solo o mezclado con otro texto, y aunque
el mensaje no traiga ninguna otra palabra — llama INMEDIATAMENTE a cotizarPorUbicacion pasando ese
texto tal cual como urlUbicacion. NUNCA respondas por tu cuenta diciendo que el link "no abrió",
"no se pudo leer" o pidiendo que lo reenvíen SIN haber llamado primero la herramienta — eso solo lo
dices si la herramienta misma te devuelve que no pudo leer coordenadas. No hace falta que el
cliente escriba nada más en el mensaje: el link solo ya es suficiente para cotizar.
IMPORTANTE — Google apagó el servicio que hacía funcionar los links cortos (maps.app.goo.gl):
muchos de esos links YA NO SE PUEDEN LEER por código, sin importar cuántas veces lo reenvíen. Si
cotizarPorUbicacion devuelve cotizado:false por no poder leer coordenadas, NO le pidas al cliente
que reenvíe el link de nuevo — en vez de eso dile que ese link no se puede leer automáticamente y
que abra el formulario de pedido (iniciarPedidoParaTercero) donde va a encontrar el botón "¿No
tienes la dirección? Selecciona la ubicación en el mapa" para marcar el punto exacto a mano.

— CLIENTE SIN DIRECCIÓN, SOLO TIENE LA UBICACIÓN (fuera de Armenia, fincas, sin nomenclatura) —
Si el local/cliente dice que no tiene dirección/barrio pero sí sabe dónde queda (o solo da nombre
y teléfono sin dirección), NO te quedes preguntando por barrio ni intentes adivinar una dirección.
Llama igual a iniciarPedidoParaTercero con los datos que sí tengas: el formulario que se abre
siempre trae el botón "¿No tienes la dirección? Selecciona la ubicación en el mapa" para marcar el
punto exacto (ideal para fincas, veredas o zonas fuera de Armenia). Puedes mencionarle brevemente
esa opción en tu respuesta, pero no hace falta preguntarla paso a paso — el formulario ya la ofrece.

— PEDIDOS PARA UN TERCERO (CUANDO EL CLIENTE ES UN LOCAL/NEGOCIO) —
Algunos clientes son locales/comercios que reenvían pedidos de SUS PROPIOS clientes (no piden
para sí mismos). IMPORTANTE: la libreta de clientes (buscarClienteLocalGuardado) es una base de
datos PERSISTENTE — no depende de la sesión ni de la conversación. Si el local guardó a un cliente
antes, sigues sabiendo quién es aunque se cierre el chat y se abra uno nuevo. NUNCA digas que "no
recuerdas" o que "cada conversación empieza desde cero" respecto a estos contactos: eso es falso,
consulta la herramienta antes de responder algo así.

VÍA RÁPIDA CON FORMULARIO (la preferida): en cuanto reconozcas que se trata de un pedido para un
tercero con intención real de enviarlo (no solo una pregunta tipo "¿la tienes guardada?"), usa
iniciarPedidoParaTercero de inmediato con los datos que puedas extraer del mensaje (nombre,
teléfono, y si vienen, direccionDetalle y barrioEntrega). Esta herramienta ya consulta la libreta
por dentro, así que NO necesitas llamar buscarClienteLocalGuardado por separado antes de ella.
Ábrele el formulario al local en vez de seguir pidiéndole los datos uno por uno en el chat — el
formulario le va a pedir el barrio (si no vino en el mensaje) y el tiempo de alistamiento, y desde
ahí mismo confirma y envía el pedido. Usa el flujo conversacional de cotizarPedidoParaTercero /
confirmarPedidoParaTercero (más abajo) SOLO como respaldo: cuando iniciarPedidoParaTercero
devuelva "ambiguo" (para preguntar cuál contacto es), o cuando el local aclare que en este pedido
en particular va a recoger en otro lugar distinto a su local (el formulario rápido no cubre ese
caso todavía).

IMPORTANTE — LOS PASOS 1 A 6 DE ABAJO SON SOLO EL FLUJO DE RESPALDO: NO los sigas por
defecto. Tu primera acción SIEMPRE debe ser intentar iniciarPedidoParaTercero (vía rápida).
Solo caes a los pasos 1-6 (preguntar por chat el origen de recogida, el tiempo, etc.) en estos
DOS casos exactos: (a) iniciarPedidoParaTercero devolvió "ambiguo": true, o (b) el local ya
aclaró en este mismo mensaje que va a recoger en un lugar distinto a su local. Si no aplica
ninguno de los dos, NUNCA preguntes por chat el origen de recogida ni el tiempo de alistamiento
antes de abrir el formulario — eso se pregunta DENTRO del formulario, no en el chat.

Reconoce esta situación en CUALQUIERA de estos casos:
a) Pegan un mensaje con nombre/teléfono/dirección de otra persona.
b) Escriben algo como "mándame un repartidor para [nombre]", "envíale un domicilio a [nombre]",
   dando SOLO el nombre, sin teléfono ni dirección.
c) Preguntan directamente si conoces/recuerdas/tienes guardado a alguien (ej. "¿sabes quién es
   Laura?", "¿la tienes guardada?").
En los casos (b) y (c), donde el cliente NO te dio teléfono ni dirección, de todas formas llama a
buscarClienteLocalGuardado de inmediato usando el nombre que te dieron, ANTES de responder nada.
No le preguntes primero si existe — consúltalo tú mismo con la herramienta y responde según el
resultado real.
1. Extrae del mensaje (pegado o no) los datos disponibles: nombre, teléfono y dirección exacta
   (SIN el barrio) del destinatario.
2. Usa buscarClienteLocalGuardado (por teléfono si lo tienes, si no por nombre) para ver si ya
   está guardado en la libreta de ese local.
   - Si aparece con UNA sola dirección guardada: úsala directo, no vuelvas a pedir nada (ya tienes
     nombre, teléfono y dirección; solo confirma con el local que sí es para esa persona/dirección).
     Esa dirección trae su propio campo "gps" — pásalo como gpsEntrega al cotizar/confirmar, para
     reutilizar la ubicación ya guardada en vez de recalcularla.
   - Si aparece con VARIAS direcciones: pregunta cuál usar (ej. "¿La Patria o Fundadores?"), y usa
     el "gps" de la dirección elegida como gpsEntrega.
   - Si NO aparece: es cliente nuevo, necesitas que el local te dé los datos que falten (teléfono,
     dirección exacta y/o barrio). NUNCA inventes ningún dato.
3. Antes de cotizar, pregúntale SIEMPRE al local dos cosas (nunca las asumas ni las copies de un
   pedido anterior en la misma conversación, aunque sea el mismo local):
   a) Si va a recoger en su dirección/local de siempre, o si en este momento está en otro lugar
      (ej. "¿Recoges en tu local de siempre o estás en otro sitio ahora mismo?"). El punto de
      recogida cambia la tarifa, y suponerlo fue la causa de que antes se cobraran tarifas
      distintas para el mismo destino.
   b) En cuánto tiempo está listo el pedido para que el repartidor lo recoja, con las mismas
      opciones del formulario de la app: "Ya está / 5 / 10 / 15 / 20 / 25 / 30 minutos". Esto es
      clave cuando el local tiene demanda alta en cocina y el domicilio se va a demorar por eso,
      no por el repartidor — así el cliente final ve la razón real de la demora en su seguimiento.
      Si el local no lo menciona espontáneamente, pregúntaselo directo antes de cotizar; no
      asumas que ya está listo.
4. Con nombre, teléfono, dirección, barrio, el origen de recogida y minutosPreparacion completos,
   usa cotizarPedidoParaTercero (origenRecogida="local" u "otro_lugar" según lo que haya dicho).
   Esto SOLO calcula tarifa y tiempo, NO crea el pedido. Muéstrale al local el resumen (tarifa y
   tiempo) y pídele confirmación explícita antes de continuar. Si la respuesta trae "avisoGps",
   coméntaselo al local antes de seguir (puede que su ubicación no se haya podido tomar).
5. Si el cliente es NUEVO (no lo encontró buscarClienteLocalGuardado), antes o junto con la
   confirmación pregúntale si quiere guardarlo en su libreta para la próxima vez.
6. Solo cuando el local confirme explícitamente (dijo "sí", "dale", "confirma", etc.), usa
   confirmarPedidoParaTercero con el MISMO origenRecogida y el MISMO minutosPreparacion que usaste
   al cotizar, y guardarCliente=true si pidió guardarlo, o false si no.
NUNCA uses confirmarPedidoParaTercero sin haber cotizado antes y sin confirmación explícita —
igual que con cualquier pedido, el cliente debe ver precio y tiempo antes de que se cree.

— GUARDAR UN CONTACTO SIN QUE HAYA UN PEDIDO DE POR MEDIO —
REGLA DE PRIORIDAD: si el mensaje trae nombre + teléfono + dirección completos de un tercero,
por defecto es un PEDIDO (usa iniciarPedidoParaTercero de la sección de arriba), NUNCA lo tomes
como "solo guardar contacto" solo porque los datos vinieron completos o parecen un mensaje
reenviado. Usa guardarClienteLocalDirecto ÚNICAMENTE cuando el local lo pida de forma EXPLÍCITA
con frases como "guárdame este contacto", "anota este cliente", "guárdalo para después" — es
decir, cuando el propio mensaje deja claro que NO quiere enviar un domicilio ahora, sino solo
guardar el dato. Ante la duda, prioriza SIEMPRE iniciarPedidoParaTercero: abrir el formulario no
hace daño (el local simplemente no lo envía si no era su intención), pero quedarse solo
guardando el contacto cuando sí quería pedir un domicilio sí es un problema.
Si el local pega o escribe los datos de un tercero (nombre + teléfono, con o sin dirección) SOLO
para que quede guardado — sin estar pidiendo un domicilio en ese momento, por ejemplo: pega una
tarjeta de contacto, reenvía un mensaje, o dice "guárdame este contacto", "anota este cliente" —
usa guardarClienteLocalDirecto de inmediato con los datos que tengas (mínimo nombre y teléfono).
NO esperes a que se cree un pedido para guardarlo, y NO le digas que no puedes guardar contactos:
sí puedes, y debes hacerlo apenas tengas nombre y teléfono. Si además te dio dirección y barrio,
inclúyelos en la misma llamada. Después de guardar, sigue la conversación con naturalidad (ej. si
parece que además quiere un domicilio, pregúntale para qué hora lo necesita).

— LISTAR LOS CONTACTOS GUARDADOS —
Si el local pregunta qué clientes tiene guardados, pide ver su libreta, o pregunta algo como "¿qué
clientes tenemos guardados?", usa listarClientesLocalGuardados y respóndele con la lista real que
te devuelva la herramienta (nombre, teléfono y direcciones de cada uno). Esta libreta es SOLO la
del local autenticado — su propia base de datos privada, aislada de la de cualquier otro local —
así que NUNCA te niegues a mostrarla citando privacidad: mostrarle su propia libreta a su propio
dueño está permitido y es justamente para lo que existe. Si la libreta está vacía, dile que
todavía no tiene contactos guardados.

— BORRAR TODOS LOS CONTACTOS GUARDADOS —
Si el local pide borrar/eliminar TODOS sus contactos guardados (ej. "bórrame todos los contactos",
"elimina mi libreta", "borra todos los clientes que tengo guardados"), esto es una acción
IRREVERSIBLE, así que sigue este orden:
1. Usa listarClientesLocalGuardados para saber cuántos contactos tiene.
2. Dile cuántos contactos borraría y adviértele explícitamente que no se puede deshacer.
3. Espera su confirmación explícita ("sí", "bórralos", "confirma").
4. Solo entonces usa borrarTodosLosContactosLocal con confirmado=true.
NUNCA llames borrarTodosLosContactosLocal sin haber completado los pasos anteriores. Esta función
solo borra la libreta COMPLETA; si el local pide borrar un solo contacto puntual, dile que por
ahora esa opción no existe, solo borrar toda la libreta.

— SEGUIMIENTO DEL PEDIDO —
Si el cliente está autenticado y pregunta por su pedido, usa la herramienta consultarEstadoPedido.
Al responder, SIEMPRE incluye TODOS estos datos sin resumir ni omitir ninguno, cada vez que te
pregunten, sin importar si ya los diste antes en la misma conversación:
- Estado actual del pedido
- Repartidor asignado (o "sin asignar" si no tiene)
- Descripción del pedido
- Valor total
- Tiempo estimado de entrega
Si el cliente pregunta específicamente DÓNDE va su repartidor o pide ver su ubicación (ej. "¿dónde
va mi pedido?", "¿ya viene?", "muéstrame dónde está"), usa la herramienta consultarUbicacionPedido
en vez de (o además de) consultarEstadoPedido — esta le muestra un mini-mapa directo en el chat.
Después de mostrar el mini-mapa, recuérdale que puede tocar "Ver seguimiento completo" para ver el
mapa grande con la ruta, o ir a la pestaña "Seguir" manualmente.
Si el cliente NO está autenticado y pregunta por su pedido, pídele que inicie sesión, o dile que
puede ir a la pestaña "Seguir" e ingresar su correo para ver el estado y el mapa ahí mismo.
LIMITACIÓN ACTUAL: estas dos herramientas solo consultan el pedido activo MÁS RECIENTE del cliente.
Si el cliente tiene dos o más pedidos activos al mismo tiempo, acláraselo brevemente y dile que en
la pestaña "Seguir" puede ver el mapa completo con TODOS sus pedidos activos y sus repartidores a
la vez (esa parte del mapa sí soporta varios pedidos simultáneos).

— QUÉ OFRECE LA APP (para responder "¿qué puedo hacer aquí?" o "¿qué beneficios tengo?") —
Si el cliente pregunta en general qué puede hacer en la app, qué funciones tiene, o qué beneficios
obtiene por usarla, resume estos puntos de forma clara y amigable (no hace falta mencionarlos todos
si el cliente pregunta algo puntual):
• Pedir domicilios dentro de Armenia y hacia municipios cercanos (pestaña "Servicio").
• Programar domicilios para una hora exacta desde "Domicilios Programados", donde también puede
  ver, editar o cancelar sus pedidos agendados.
• Seguimiento en tiempo real con mapa (pestaña "Seguir"): ve el punto de recogida, el punto de
  entrega y la ubicación de su repartidor en vivo. Si tiene más de un pedido activo a la vez, el
  mapa le muestra los puntos y repartidores de todos sus pedidos simultáneamente.
• Chat directo con su repartidor (texto, fotos y notas de voz) apenas el pedido es aceptado, para
  coordinar detalles de la entrega sin necesidad de llamar.
• Sistema de niveles y Ruleta de Descuentos: acumula domicilios y sube de nivel (ver niveles abajo);
  además, cada 7 pedidos completados gana un giro en la ruleta que puede premiar cupones de descuento.
• Día Bomba (martes): 20% de descuento en domicilios dentro de Armenia, en franjas horarias
  específicas (8-11am, 2-6pm, 8-10pm). Es un beneficio colectivo de toda la comunidad de clientes
  Servi Aliados que se desbloquea cuando entre todos alcanzan cierto número de servicios en la
  semana — si no sabes si está activo en este momento, dilo así y no prometas el descuento como
  garantizado; sugiere revisar la pestaña "Premios" en la app.
• Soporte humano real por WhatsApp cuando lo necesite, además de tenerme a mí disponible para lo
  del día a día.

— BENEFICIOS DE HABLAR CONMIGO (SERVIBOT) —
Si te preguntan para qué sirve hablarte a ti o qué ventaja tiene usar la IA en vez del formulario,
menciona que contigo pueden:
• Agendar un domicilio programado solo describiéndolo en un mensaje (le pre-lleno el formulario si
  menciona nombre, teléfono o dirección exacta).
• Consultar el estado de su pedido al instante, sin esperar a que alguien responda.
• Pedirte que le muestres dónde va su repartidor: le despliegas un mini-mapa directo en el chat.
• Avisar urgente al repartidor si se le olvidó algo del pedido en curso, sin tener que llamarlo.
• Cancelar un pedido programado (si todavía no tiene repartidor asignado).
• Resolver al instante y a cualquier hora dudas de tarifas, zonas, tiempos y cómo funciona la app,
  sin tener que esperar a que alguien le responda.

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
- Respuestas concisas: máximo 3–4 párrafos cortos en temas generales. EXCEPCIÓN: cuando informes
  el estado de un pedido con consultarEstadoPedido, NO apliques este límite — da siempre todos
  los datos completos aunque ocupe más espacio, la brevedad no aplica ahí.
- [MODO PRUEBAS: sin restricción de horario por ahora]
- Mantente siempre en temas de Servi Aliados (precios, zonas, tiempos, pedidos, cuenta, etc). Si
  te preguntan algo totalmente ajeno (chistes, tareas, trivia, clima), redirige amablemente al tema.`;
}

// Reconoce direcciones tradicionales de Armenia en formato calle/carrera
// (Centro y Norte usan esta nomenclatura, a diferencia de las ciudadelas que
// usan manzana/casa). Acepta variantes: "CRA 14# 14 23", "carrera 14 número
// 14-23", "calle 14 # 14-23", con o sin separador y con o sin guión. Si el
// número principal trae una "N" MAYÚSCULA pegada (ej. "14N"), es Norte; si
// no, se asume Centro (las dos zonas donde aplica esta nomenclatura). No
// confunde la "N" de Norte con la palabra "número" gracias al lookahead que
// exige que después de la N no venga otra letra.
function extraerDireccionCalleCarrera(texto) {
  if (!texto) return null;
  const regex = /(cra|cll|kra|calle|carrera)\.?\s*(\d+)(N(?![a-záéíóúñ]))?\s*(?:#|no\.?|nro\.?|n[uú]mero)?\s*(\d+)[\s-]+(\d+)/i;
  const m = texto.match(regex);
  if (!m) return null;
  const tipoRaw = m[1].toLowerCase();
  const tipo = (tipoRaw === 'calle' || tipoRaw === 'cll') ? 'Calle' : 'Cra';
  const esNorte = m[3] === 'N';
  const direccionDetalle = `${tipo} ${m[2]}${esNorte ? 'N' : ''} #${m[4]}-${m[5]}`;
  return { direccionDetalle, zona: esNorte ? 'Norte' : 'Centro' };
}

// Respaldo por si Gemini no extrae el teléfono o la dirección del mensaje del
// cliente (la extracción del modelo no es 100% consistente). Busca patrones
// directos en el texto para no depender solo de que la IA decida hacerlo.
function extraerFallbackEntrega(texto) {
  const resultado = { telefonoEntrega: null, direccionEntrega: null, nombreEntrega: null, zonaDetectada: null };
  if (!texto) return resultado;
  const telMatch = texto.match(/(\d{3}[\s.-]?\d{3}[\s.-]?\d{4})/);
  if (telMatch) resultado.telefonoEntrega = telMatch[1].replace(/[\s.-]/g, '');
  const dirMatch = texto.match(/manzana\s*\d+[^\d]{0,12}casa\s*\d+/i);
  if (dirMatch) {
    resultado.direccionEntrega = dirMatch[0];
  } else {
    const cc = extraerDireccionCalleCarrera(texto);
    if (cc) {
      resultado.direccionEntrega = cc.direccionDetalle;
      resultado.zonaDetectada = cc.zona;
    }
  }
  // Nombre: busca "a/para <Nombre>" con mayúscula inicial, evitando palabras
  // comunes que no son nombres propios (mi, la, el, un, una, etc).
  const stopwords = new Set(['Mi', 'La', 'El', 'Un', 'Una', 'Su', 'Que', 'Casa', 'Manzana']);
  const nombreMatch = texto.match(/\b(?:a|para)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/);
  if (nombreMatch && !stopwords.has(nombreMatch[1])) {
    resultado.nombreEntrega = nombreMatch[1];
  }
  return resultado;
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
    const args = { ...(call.args || {}) };
    const fallback = extraerFallbackEntrega(mensaje);
    if (!args.telefonoEntrega && fallback.telefonoEntrega) args.telefonoEntrega = fallback.telefonoEntrega;
    if (!args.direccionEntrega && fallback.direccionEntrega) args.direccionEntrega = fallback.direccionEntrega;
    if (!args.nombreEntrega && fallback.nombreEntrega) args.nombreEntrega = fallback.nombreEntrega;
    // Si la dirección (venga del modelo o del fallback) es formato calle/carrera,
    // se detecta la zona (Centro/Norte) para sugerirla en el selector de barrios;
    // no reemplaza la selección manual, solo la deja pre-sugerida.
    let zonaDetectada = fallback.zonaDetectada || null;
    if (args.direccionEntrega) {
      const cc = extraerDireccionCalleCarrera(args.direccionEntrega);
      if (cc) {
        args.direccionEntrega = cc.direccionDetalle;
        zonaDetectada = cc.zona;
      }
    }
    const disp = await iniciarAgendaProgramada(clienteAuthUID, args);
    const result2 = await chat.sendMessage([
      { functionResponse: { name: 'iniciarAgendaProgramada', response: disp } },
    ]);
    return {
      respuesta: result2.response.text(),
      accion: disp.disponible ? 'mostrarSelectorBarrios' : null,
      datosAgenda: disp.disponible ? {
        hora: disp.hora, minuto: disp.minuto, dia: disp.dia,
        nombreEntrega: disp.nombreEntrega, telefonoEntrega: disp.telefonoEntrega, direccionEntrega: disp.direccionEntrega,
        zonaSugerida: zonaDetectada,
      } : null,
    };
  }

  if (call && call.name === 'cancelarPedidoProgramado') {
    const datosCancel = await cancelarPedidoProgramado(clienteAuthUID);
    const result2 = await chat.sendMessage([
      { functionResponse: { name: 'cancelarPedidoProgramado', response: datosCancel } },
    ]);
    return { respuesta: result2.response.text() };
  }

  if (call && call.name === 'consultarUbicacionPedido') {
    const datosUbicacion = logueado
      ? await consultarUbicacionPedido(clienteEmail)
      : { encontrado: false, mensaje: 'El cliente no ha iniciado sesión, no se puede consultar su pedido.' };
    const result2 = await chat.sendMessage([
      { functionResponse: { name: 'consultarUbicacionPedido', response: datosUbicacion } },
    ]);
    const mostrarMapa = !!(datosUbicacion.encontrado && datosUbicacion.tieneRepartidor && datosUbicacion.tieneUbicacion);
    return {
      respuesta: result2.response.text(),
      accion: mostrarMapa ? 'mostrarUbicacionPedido' : null,
      datosUbicacion: mostrarMapa ? {
        lat: datosUbicacion.lat, lng: datosUbicacion.lng,
        repartidorNombre: datosUbicacion.repartidorNombre, estado: datosUbicacion.estado,
      } : null,
    };
  }

  if (call && call.name === 'avisarRepartidorOlvido') {
    const datosAviso = logueado
      ? await avisarRepartidorOlvido(clienteEmail, (call.args || {}).mensajeParaRepartidor)
      : { enviado: false, mensaje: 'El cliente no ha iniciado sesión, no se puede avisar al repartidor.' };
    const result2 = await chat.sendMessage([
      { functionResponse: { name: 'avisarRepartidorOlvido', response: datosAviso } },
    ]);
    return { respuesta: result2.response.text() };
  }

  if (call && call.name === 'buscarClienteLocalGuardado') {
    const datosBusqueda = await buscarClienteLocalGuardado(clienteAuthUID, call.args || {});
    const result2 = await chat.sendMessage([
      { functionResponse: { name: 'buscarClienteLocalGuardado', response: datosBusqueda } },
    ]);
    return { respuesta: result2.response.text() };
  }

  if (call && call.name === 'iniciarPedidoParaTercero') {
    const disp = await iniciarPedidoParaTercero(clienteAuthUID, call.args || {});
    const result2 = await chat.sendMessage([
      { functionResponse: { name: 'iniciarPedidoParaTercero', response: disp } },
    ]);
    return {
      respuesta: result2.response.text(),
      accion: disp.disponible ? 'mostrarFormularioTercero' : null,
      datosTercero: disp.disponible ? {
        nombreCliente: disp.nombreCliente,
        telefonoCliente: disp.telefonoCliente,
        direccionDetalle: disp.direccionDetalle,
        barrioEntrega: disp.barrioEntrega,
        esContactoNuevo: disp.esContactoNuevo,
        gpsEntrega: disp.gpsEntrega || null,
      } : null,
    };
  }

  if (call && call.name === 'cotizarPorUbicacion') {
    const datosCotizUbicacion = await cotizarPorUbicacion(clienteAuthUID, call.args || {});
    const result2 = await chat.sendMessage([
      { functionResponse: { name: 'cotizarPorUbicacion', response: datosCotizUbicacion } },
    ]);
    return { respuesta: result2.response.text() };
  }

  if (call && call.name === 'cotizarPedidoParaTercero') {
    const datosCotizacion = await cotizarPedidoParaTercero(clienteAuthUID, call.args || {});
    const result2 = await chat.sendMessage([
      { functionResponse: { name: 'cotizarPedidoParaTercero', response: datosCotizacion } },
    ]);
    return { respuesta: result2.response.text() };
  }

  if (call && call.name === 'confirmarPedidoParaTercero') {
    const datosConfirmacion = await confirmarPedidoParaTercero(clienteAuthUID, clienteEmail, call.args || {});
    const result2 = await chat.sendMessage([
      { functionResponse: { name: 'confirmarPedidoParaTercero', response: datosConfirmacion } },
    ]);
    return { respuesta: result2.response.text() };
  }

  if (call && call.name === 'guardarClienteLocalDirecto') {
    const datosGuardado = await guardarClienteLocalDirecto(clienteAuthUID, call.args || {});
    const result2 = await chat.sendMessage([
      { functionResponse: { name: 'guardarClienteLocalDirecto', response: datosGuardado } },
    ]);
    return { respuesta: result2.response.text() };
  }

  if (call && call.name === 'listarClientesLocalGuardados') {
    const datosLista = await listarClientesLocalGuardados(clienteAuthUID);
    const result2 = await chat.sendMessage([
      { functionResponse: { name: 'listarClientesLocalGuardados', response: datosLista } },
    ]);
    return { respuesta: result2.response.text() };
  }

  if (call && call.name === 'borrarTodosLosContactosLocal') {
    const datosBorrado = await borrarTodosLosContactosLocal(clienteAuthUID, call.args || {});
    const result2 = await chat.sendMessage([
      { functionResponse: { name: 'borrarTodosLosContactosLocal', response: datosBorrado } },
    ]);
    return { respuesta: result2.response.text() };
  }

  return { respuesta: result.response.text() };
});

// ======================================================================
// ServiBot DEL REPARTIDOR — chatbot de IA separado del chatbot del
// cliente (servibotChat). El frontend de indexrepartidor/index.html ya
// llama a esta función vía repartidorBotChatFn ('repartidorBotChat').
// ======================================================================
exports.repartidorBotChat = onCall({ secrets: [GEMINI_API_KEY] }, async (request) => {
  const { mensaje, historial } = request.data;
  const repartidorUID = request.auth?.uid;
  if (!repartidorUID) {
    throw new HttpsError('unauthenticated', 'Debes iniciar sesión como repartidor.');
  }
  if (!mensaje) {
    throw new HttpsError('invalid-argument', 'Falta el mensaje.');
  }

  const nombreSnap = await admin.database().ref(`repartidores_info/${repartidorUID}/nombre`).get();
  const repartidorNombre = nombreSnap.exists() ? nombreSnap.val() : null;

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY.value());
  const model = genAI.getGenerativeModel({
    model: 'gemini-3.1-flash-lite',
    tools: herramientasRepartidor,
    systemInstruction: buildSystemPromptRepartidor(repartidorNombre),
  });

  const historialGemini = Array.isArray(historial)
    ? historial
        .filter(h => h && typeof h.content === 'string' && (h.role === 'user' || h.role === 'model'))
        .slice(-10)
        .map(h => ({ role: h.role, parts: [{ text: h.content }] }))
    : [];

  const chat = model.startChat({ history: historialGemini });
  const result = await chat.sendMessage(mensaje);
  const call = result.response.functionCalls()?.[0];

  if (call && call.name === 'consultarTurno') {
    const datos = await consultarTurnoRepartidor(repartidorUID);
    const result2 = await chat.sendMessage([
      { functionResponse: { name: 'consultarTurno', response: datos } },
    ]);
    return { respuesta: result2.response.text() };
  }

  if (call && call.name === 'consultarEstadoCuenta') {
    const datos = await consultarEstadoCuentaRepartidor(repartidorUID);
    const result2 = await chat.sendMessage([
      { functionResponse: { name: 'consultarEstadoCuenta', response: datos } },
    ]);
    return { respuesta: result2.response.text() };
  }

  if (call && call.name === 'reportarProblemaPedido') {
    const datos = await reportarProblemaPedidoRepartidor(repartidorUID, repartidorNombre, (call.args || {}).descripcion);
    const result2 = await chat.sendMessage([
      { functionResponse: { name: 'reportarProblemaPedido', response: datos } },
    ]);
    return { respuesta: result2.response.text() };
  }

  if (call && call.name === 'reportarErrorApp') {
    const datos = await reportarErrorAppRepartidor(repartidorUID, repartidorNombre, (call.args || {}).descripcion);
    const result2 = await chat.sendMessage([
      { functionResponse: { name: 'reportarErrorApp', response: datos } },
    ]);
    return { respuesta: result2.response.text() };
  }

  if (call && call.name === 'consultarAvisosCliente') {
    const datos = await consultarAvisosClienteRepartidor(repartidorUID);
    const result2 = await chat.sendMessage([
      { functionResponse: { name: 'consultarAvisosCliente', response: datos } },
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
// FORMULARIO RÁPIDO "PEDIDO PARA TERCERO" — envío directo desde la
// tarjeta embebida en el chat (sin pasar por Gemini/function-calling).
// origenRecogida viene del botón que el local seleccionó en el formulario
// ("Recoger en el local" u "Otro lugar"); si no llega nada, se asume local.
// ======================================================================
exports.confirmarPedidoTerceroDirecto = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Debes iniciar sesión.');
  const clienteAuthUID = `cliente_auth_${uid}`;
  const clienteEmail = request.auth?.token?.email || null;

  const datos = request.data || {};
  const args = {
    nombreCliente: datos.nombreCliente,
    telefonoCliente: datos.telefonoCliente,
    direccionDetalle: datos.direccionDetalle,
    barrioEntrega: datos.barrioEntrega,
    gpsEntrega: (datos.gpsEntrega && datos.gpsEntrega.lat && datos.gpsEntrega.lng) ? datos.gpsEntrega : null,
    gpsRecogidaManual: (datos.gpsRecogidaManual && datos.gpsRecogidaManual.lat && datos.gpsRecogidaManual.lng) ? datos.gpsRecogidaManual : null,
    minutosPreparacion: datos.minutosPreparacion,
    origenRecogida: datos.origenRecogida === 'otro_lugar' ? 'otro_lugar' : 'local',
    guardarCliente: true,
  };

  const resultado = await confirmarPedidoParaTercero(clienteAuthUID, clienteEmail, args);
  if (!resultado.confirmado) {
    throw new HttpsError('failed-precondition', resultado.mensaje || 'No se pudo crear el pedido.');
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
        const km = await calcularDistanciaRutaKm(pedido.gpsRecogida, coordsEnt);
        updates.montoTotal = precioSegunKm(km);
        updates.montoOriginal = updates.montoTotal;
        updates.razonPrecio = updates.montoTotal === null
          ? `Fuera del rango de cobertura automática (${km.toFixed(1)} km); requiere confirmar precio manualmente`
          : `Estimado automáticamente por distancia (${km.toFixed(1)} km)`;
        updates.requiereMapeador = updates.montoTotal === null;
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

      // Ordena por carga (menos pedidos activos primero) y, entre repartidores
      // con la misma carga, prioriza al que está más cerca del punto de
      // recogida (mejor ruteo, menos tiempo muerto llegando al origen).
      const candidatos = disponibles
        .slice()
        .map(r => ({
          ...r,
          _distKm: (r.ubicacionActual && pedido.gpsRecogida)
            ? calcularDistanciaKm(r.ubicacionActual, pedido.gpsRecogida)
            : null,
        }))
        .sort((a, b) => {
          const cargaA = a.pedidosActivos || 0;
          const cargaB = b.pedidosActivos || 0;
          if (cargaA !== cargaB) return cargaA - cargaB;
          if (a._distKm !== null && b._distKm !== null) return a._distKm - b._distKm;
          if (a._distKm !== null) return -1;
          if (b._distKm !== null) return 1;
          return 0;
        });

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

// ======================================================================
// SOS DEL REPARTIDOR → PUSH DIRECTO AL CLIENTE AFECTADO
// Cuando un repartidor activa el SOS, si en ese momento tiene un pedido
// activo asignado, se le manda un push (no solo chat) al cliente de ESE
// pedido para que sepa que puede haber demora, sin exponer detalles del
// contratiempo. No se notifica a otros clientes.
// ======================================================================
exports.onNuevaAlertaSOS = functions.database
  .ref('/sos_alertas/{alertaId}')
  .onCreate(async (snap) => {
    const alerta = snap.val();
    if (!alerta) return null;

    // El campo puede venir con distintos nombres según quién la creó.
    const repartidorUID = alerta.repartidorUID || alerta.repartidorId || alerta.uid || alerta.repUid;
    if (!repartidorUID) return null;

    const infoSnap = await admin.database().ref(`repartidores_info/${repartidorUID}/pedidoActivoClienteId`).get();
    if (!infoSnap.exists()) return null; // el repartidor no tenía pedido activo en ese momento

    const clienteUID = infoSnap.val();
    if (!clienteUID) return null;

    await enviarPush(
      clienteUID,
      'Tu pedido puede tardar un poco más',
      'Tu repartidor tuvo un contratiempo en el camino. Ya estamos al tanto y coordinando ayuda, tu pedido sigue en curso.',
      { tipo: 'sos_repartidor' }
    );
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

// ══════════════════════════════════════════════════════════════════
// 📍 UBICACIÓN EN SEGUNDO PLANO — webhook nativo (@capgo/background-geolocation)
// ══════════════════════════════════════════════════════════════════
// El plugin nativo del repartidor manda cada actualización de ubicación
// por HTTP POST directo desde Kotlin (sin pasar por el WebView/JS), así
// que sigue funcionando aunque Android congele la app en 2do plano.
// Como es un endpoint público (no lleva sesión de Firebase Auth), se
// protege con un token = HMAC(uid, secreto), generado una sola vez al
// iniciar sesión mediante obtenerTokenUbicacion.
const crypto = require('crypto');
const { onRequest } = require('firebase-functions/v2/https');
const UBICACION_WEBHOOK_SECRET = defineSecret('UBICACION_WEBHOOK_SECRET');

function _generarTokenUbicacion(uid, secreto) {
  return crypto.createHmac('sha256', secreto).update(uid).digest('hex');
}

exports.obtenerTokenUbicacion = onCall({ secrets: [UBICACION_WEBHOOK_SECRET] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Debes iniciar sesión.');
  const token = _generarTokenUbicacion(uid, UBICACION_WEBHOOK_SECRET.value());
  return { token };
});

exports.actualizarUbicacionRepartidor = onRequest({ secrets: [UBICACION_WEBHOOK_SECRET] }, async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed');
      return;
    }
    const uid = req.query.uid;
    const token = req.query.token;
    if (!uid || !token) {
      res.status(400).send('Faltan uid o token');
      return;
    }
    const tokenEsperado = _generarTokenUbicacion(String(uid), UBICACION_WEBHOOK_SECRET.value());
    if (token !== tokenEsperado) {
      res.status(403).send('Token inválido');
      return;
    }
    const body = req.body || {};
    const lat = Number(body.latitude);
    const lon = Number(body.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      res.status(400).send('Ubicación inválida');
      return;
    }
    await admin.database().ref(`repartidores_info/${uid}`).update({
      lat,
      lon,
      accuracy: Number(body.accuracy) || 0,
      speed: Number(body.speed) || 0,
      heading: Number(body.bearing) || 0,
      online: true,
      trackingActivo: true,
      lastSeen: Date.now(),
      origenUbicacion: 'webhook_nativo'
    });
    res.status(200).send('ok');
  } catch (e) {
    console.error('❌ Error en actualizarUbicacionRepartidor:', e);
    res.status(500).send('Error interno');
  }
});
