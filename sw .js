// ============================================================
// SERVICE WORKER — Servi Aliados (cliente)
// Guarda una copia del "cascarón" de la app (index.html) para que la
// aplicación SIEMPRE pueda abrir, aunque el teléfono no tenga internet.
// Estrategia: red primero (siempre la versión más nueva cuando hay
// conexión) y si la red falla, sirve la última copia guardada.
// ============================================================
const CACHE_NAME = 'servialiados-cliente-v1';
const URLS_A_GUARDAR = [
  './',
  './index.html'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(URLS_A_GUARDAR))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((nombres) =>
      Promise.all(
        nombres
          .filter((nombre) => nombre !== CACHE_NAME)
          .map((nombre) => caches.delete(nombre))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((respuestaRed) => {
        // Si la red funcionó, actualiza la copia guardada con la versión fresca
        const copia = respuestaRed.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copia));
        return respuestaRed;
      })
      .catch(() =>
        // Sin internet: sirve la copia guardada, o si no existe esa ruta
        // exacta, sirve el cascarón principal (index.html) igual
        caches.match(event.request).then(
          (respuestaCache) => respuestaCache || caches.match('./index.html')
        )
      )
  );
});
