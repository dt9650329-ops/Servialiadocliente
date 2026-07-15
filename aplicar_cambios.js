// Script para actualizar index.html:
// 1) Agrega el import + inicialización del SDK de Firebase Functions (cliente)
// 2) Reemplaza window.girarRuleta para que llame a la Cloud Function
//    "girarRuleta" en vez de decidir el premio y escribir Firebase directo.
//
// Uso: node aplicar_cambios.js index.html

const fs = require("fs");
const path = process.argv[2];
if (!path) {
  console.error("Uso: node aplicar_cambios.js <ruta-a-index.html>");
  process.exit(1);
}

let src = fs.readFileSync(path, "utf8");
const originalLength = src.length;

// ------------------------------------------------------------------
// CAMBIO 1: agregar import de firebase-functions.js
// ------------------------------------------------------------------
const anchorImport =
  ` import { \n getStorage, \n ref as storageRef, \n uploadBytesResumable, \n getDownloadURL \n } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";`;

if (!src.includes(anchorImport)) {
  console.error("❌ No se encontró el bloque de import de firebase-storage.js (CAMBIO 1). Nada fue modificado.");
  process.exit(1);
}

const nuevoImport =
  anchorImport +
  `\n\n import { \n getFunctions, \n httpsCallable \n } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";`;

src = src.replace(anchorImport, nuevoImport);

// ------------------------------------------------------------------
// CAMBIO 2: declarar/inicializar "functions" y exponer el callable
// ------------------------------------------------------------------
const anchorInit =
` let app, db, auth, storage;
 try {
 app = initializeApp(firebaseConfig);
 db = getDatabase(app);
 auth = getAuth(app); 
 storage = getStorage(app);
 console.log(' Firebase inicializado correctamente');
 } catch(e) {
 console.error(' Firebase no pudo iniciar:', e.message);
 } 

 window.db = db;`;

if (!src.includes(anchorInit)) {
  console.error("❌ No se encontró el bloque de inicialización de Firebase (CAMBIO 2). Nada fue modificado.");
  process.exit(1);
}

const nuevoInit =
` let app, db, auth, storage, functions, girarRuletaCallable;
 try {
 app = initializeApp(firebaseConfig);
 db = getDatabase(app);
 auth = getAuth(app); 
 storage = getStorage(app);
 functions = getFunctions(app, 'us-central1');
 girarRuletaCallable = httpsCallable(functions, 'girarRuleta');
 console.log(' Firebase inicializado correctamente');
 } catch(e) {
 console.error(' Firebase no pudo iniciar:', e.message);
 } 

 window.db = db;
 window.girarRuletaCallable = girarRuletaCallable;`;

src = src.replace(anchorInit, nuevoInit);

// ------------------------------------------------------------------
// CAMBIO 3: reemplazar window.girarRuleta completo
// ------------------------------------------------------------------
const anchorGirarRuletaStart = " window.girarRuleta = function() {";
const idxStart = src.indexOf(anchorGirarRuletaStart);
if (idxStart === -1) {
  console.error("❌ No se encontró 'window.girarRuleta = function() {' (CAMBIO 3). Nada fue modificado.");
  process.exit(1);
}

// Encontrar el cierre de la función contando llaves desde el '{' inicial
const braceOpenIdx = src.indexOf("{", idxStart);
let depth = 0;
let i = braceOpenIdx;
for (; i < src.length; i++) {
  if (src[i] === "{") depth++;
  else if (src[i] === "}") {
    depth--;
    if (depth === 0) break;
  }
}
if (depth !== 0) {
  console.error("❌ No se pudo encontrar el cierre balanceado de girarRuleta (CAMBIO 3). Nada fue modificado.");
  process.exit(1);
}
// i apunta al '}' final de la función. Después viene ' ;' o ';' que cerraba
// la asignación "window.girarRuleta = function() {...};"
let idxEnd = i + 1; // justo después del '}'
// Consumir un ';' inmediato si está
if (src[idxEnd] === ";") idxEnd++;

const bloqueViejo = src.slice(idxStart, idxEnd);

const bloqueNuevo = ` window.girarRuleta = async function() {
 const est = _premiosGetEstado();
 if ((est.girosDisp || 0) <= 0) {
 alert('No tienes giros disponibles. Completa 7 pedidos para ganar uno.');
 return;
 }

 const btnGirar = document.getElementById('btn-girar-ruleta');
 if (btnGirar) btnGirar.disabled = true;

 // ✅ El premio ya NO se decide en el navegador. Se lo pedimos al
 // servidor (Cloud Function girarRuleta) para que nadie pueda
 // manipular el resultado ni inventarse un cupón sin haber girado.
 let resultado;
 try {
 const resp = await window.girarRuletaCallable();
 resultado = resp.data;
 } catch (e) {
 console.warn(' Error llamando a girarRuleta:', e);
 alert(e && e.message ? e.message : 'No se pudo girar la ruleta. Intenta de nuevo.');
 if (btnGirar) btnGirar.disabled = false;
 return;
 }

 const idxGanado = resultado.idxGanado;
 const premioGanado = RULETA_PREMIOS[idxGanado];

 // Calcular ángulo final — sectores visuales IGUALES (360°/n)
 const n = RULETA_PREMIOS.length;
 const sliceEqual = (2 * Math.PI) / n;
 const angInicio = idxGanado * sliceEqual;
 const angPremio = angInicio + sliceEqual / 2;
 const targetAngle = (2 * Math.PI * 5) + ((3 * Math.PI / 2) - angPremio);

 // Animar
 let current = 0;
 const duration = 3000;
 const start = performance.now();
 function step(now) {
 const elapsed = now - start;
 const t = Math.min(elapsed / duration, 1);
 const ease = 1 - Math.pow(1 - t, 3);
 current = targetAngle * ease;
 _dibujarRuleta(current);
 if (t < 1) {
 requestAnimationFrame(step);
 } else {
 // Giro terminado — el servidor ya descontó el giro y guardó el
 // bono en Firebase; acá solo mostramos el resultado. El listener
 // en tiempo real (escucharPremiosEnVivo / escucharBonosOtorgados)
 // se encarga de refrescar girosDisp y la lista de bonos solo.
 const esVolverATirar = resultado.esVolverATirar;
 const esSigueIntentando = resultado.esSigueIntentando;
 const esSinPremio = esSigueIntentando;
 const codigo = resultado.codigo || '';

 const resDiv = document.getElementById('ruleta-resultado');
 const resTxt = document.getElementById('ruleta-resultado-texto');
 const resCod = document.getElementById('ruleta-cupon-codigo');
 if (resDiv && resTxt && resCod) {
 resTxt.textContent = esVolverATirar
 ? ' ¡Tira otra vez! Se te acreditó un giro extra'
 : esSinPremio
 ? ' Sin suerte esta vez... ¡Sigue intentando!'
 : \` ¡Ganaste un cupón de \${premioGanado.label} de descuento!\`;
 resCod.textContent = codigo ? \`Código: \${codigo} · Muéstraselo al admin\` : '';
 resCod.style.display = codigo ? 'inline-block' : 'none';
 resDiv.style.display = 'block';
 }
 _actualizarBonosUI();
 window.initPremiosUI();
 if (btnGirar) btnGirar.disabled = false;
 }
 }
 requestAnimationFrame(step);
 };`;

src = src.replace(bloqueViejo, bloqueNuevo);

fs.writeFileSync(path, src, "utf8");
console.log("✅ Cambios aplicados correctamente.");
console.log("Tamaño original:", originalLength, "caracteres");
console.log("Tamaño nuevo:", src.length, "caracteres");
