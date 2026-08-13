// Red Lotus — Firebase Cloud Messaging Service Worker.
// Wird von jeder App im selben Ordner (Kalender, Alice, ...) über
// navigator.serviceWorker.register('firebase-messaging-sw.js') genutzt, um
// Push-Benachrichtigungen zu empfangen, auch wenn die Seite gerade nicht
// offen ist. Muss im Wurzelverzeichnis liegen (gleiche Ebene wie index.html),
// damit der Standard-Scope alle Unterseiten abdeckt.
importScripts('https://www.gstatic.com/firebasejs/12.15.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.15.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyA0y6NWpF3N7241mA72Cj-gU_pvbqpNdD4",
  authDomain: "red-lotus-eventkalender.firebaseapp.com",
  projectId: "red-lotus-eventkalender",
  storageBucket: "red-lotus-eventkalender.firebasestorage.app",
  messagingSenderId: "864967561482",
  appId: "1:864967561482:web:98ee51f304748e511f2af3"
});

const messaging = firebase.messaging();

// Zeigt eingehende Push-Nachrichten an, wenn keine Registerkarte der Seite
// im Vordergrund ist (Hintergrund-/geschlossener-Browser-Fall).
messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || 'Red Lotus';
  const body = (payload.notification && payload.notification.body) || '';
  self.registration.showNotification(title, {
    body,
    icon: 'icon-192.png',
    badge: 'icon-192.png'
  });
});
