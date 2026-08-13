// Red Lotus Alice — minimaler Service Worker.
// Zweck: Chrome/Android verlangt einen registrierten Service Worker mit
// Fetch-Handler, damit "App installieren" (statt nur "Verknüpfung
// hinzufügen") angeboten wird. Es wird bewusst NICHT gecacht, damit immer
// die aktuellste Version von alice.html geladen wird (frischer Digest).
self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', () => {
  // Absichtlich leer — Anfragen laufen normal übers Netzwerk weiter.
});
