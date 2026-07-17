// Red Lotus — minimaler Service Worker
// Zweck: (1) macht die Seiten als "richtige App" installierbar (Homescreen-Icon,
// Vollbild ohne Browserleiste), (2) einfacher Offline-Fallback für die HTML-Hülle.
// Wichtig: Live-Daten (Termine, Einkaufsliste) kommen weiterhin direkt und immer
// frisch aus Firestore — hier wird NICHTS von den eigentlichen Daten zwischengespeichert,
// nur die statische Seite selbst, damit sie auch bei kurzzeitig fehlendem Netz öffnet.

const CACHE_NAME = 'red-lotus-shell-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(()=>{});
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
