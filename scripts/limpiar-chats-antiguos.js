/**
 * limpiar-chats-antiguos.js
 * ---------------------------------------------------------
 * Borra mensajes de chat con más de X horas de antigüedad
 * (borrado "rodante": nunca corta una conversación activa,
 * solo elimina lo que ya pasó el límite de tiempo).
 *
 * Rutas que limpia (edita el array RUTAS_A_LIMPIAR si necesitas
 * agregar/quitar nodos, por ejemplo chat_p2p/{pedidoId}):
 *
 *   - chats/{uid}/{mensajeId}            -> chat cliente-repartidor
 *   - soporte_cliente/{uid}/{mensajeId}  -> chat cliente-admin
 *
 * Requiere las variables de entorno:
 *   FIREBASE_SERVICE_ACCOUNT_KEY  -> JSON completo de la service account
 *   FIREBASE_DB_URL               -> URL de tu Realtime Database
 *
 * Se ejecuta desde GitHub Actions (ver .github/workflows/limpiar-chats.yml)
 * ---------------------------------------------------------
 */

const admin = require("firebase-admin");

const HORAS_LIMITE = 36;
const LIMITE_MS = HORAS_LIMITE * 60 * 60 * 1000;

// Rutas de 2 niveles: raiz/{id}/{mensajeId} -> cada mensaje tiene "timestamp"
const RUTAS_A_LIMPIAR = [
  "chats",
  "soporte_cliente",
  // "chat_p2p", // <- descomenta si tu app de repartidor/admin usa esta ruta
];

function inicializarFirebase() {
  const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  const dbUrl = process.env.FIREBASE_DB_URL;

  if (!serviceAccountRaw || !dbUrl) {
    throw new Error(
      "Faltan variables de entorno: FIREBASE_SERVICE_ACCOUNT_KEY y/o FIREBASE_DB_URL"
    );
  }

  const serviceAccount = JSON.parse(serviceAccountRaw);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: dbUrl,
  });

  return admin.database();
}

async function limpiarRuta(db, rutaRaiz) {
  const ahora = Date.now();
  let totalRevisados = 0;
  let totalBorrados = 0;

  const rootSnap = await db.ref(rutaRaiz).once("value");
  if (!rootSnap.exists()) {
    console.log(`[${rutaRaiz}] no existe / está vacío, se omite.`);
    return { totalRevisados, totalBorrados };
  }

  const contenedores = rootSnap.val(); // { uid1: { msgId: {...} }, uid2: {...} }

  for (const contenedorId of Object.keys(contenedores)) {
    const mensajes = contenedores[contenedorId];
    if (!mensajes || typeof mensajes !== "object") continue;

    const updates = {};

    for (const msgId of Object.keys(mensajes)) {
      const msg = mensajes[msgId];
      totalRevisados++;

      const ts = msg && typeof msg === "object" ? msg.timestamp : null;

      // Si un mensaje no tiene timestamp válido, no lo tocamos (mejor
      // prevenir borrados accidentales que perder datos).
      if (!ts || typeof ts !== "number") continue;

      const antiguedad = ahora - ts;
      if (antiguedad > LIMITE_MS) {
        updates[`${rutaRaiz}/${contenedorId}/${msgId}`] = null;
        totalBorrados++;
      }
    }

    if (Object.keys(updates).length > 0) {
      await db.ref().update(updates);
    }
  }

  return { totalRevisados, totalBorrados };
}

async function main() {
  console.log(`Iniciando limpieza de chats (> ${HORAS_LIMITE}h de antigüedad)...`);
  const db = inicializarFirebase();

  let granTotalRevisados = 0;
  let granTotalBorrados = 0;

  for (const ruta of RUTAS_A_LIMPIAR) {
    const { totalRevisados, totalBorrados } = await limpiarRuta(db, ruta);
    console.log(
      `[${ruta}] revisados: ${totalRevisados} | borrados: ${totalBorrados}`
    );
    granTotalRevisados += totalRevisados;
    granTotalBorrados += totalBorrados;
  }

  console.log(
    `Listo. Total revisados: ${granTotalRevisados} | Total borrados: ${granTotalBorrados}`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("Error en limpieza de chats:", err);
  process.exit(1);
});
