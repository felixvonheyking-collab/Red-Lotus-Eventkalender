// Red Lotus — Service Worker für Push-Benachrichtigungen (Firebase Cloud Messaging).
// Diese Datei muss im GitHub-Pages-Repo GENAU in diesem Namen im Root-Verzeichnis
// liegen (neben index.html), sonst findet der Browser sie nicht.

importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

// Gleiche Firebase-Projektdaten wie in index.html / einkaufsliste.html.
firebase.initializeApp({
  apiKey: "AIzaSyA0y6NWpF3N7241mA72Cj-gU_pvbqpNdD4",
  authDomain: "red-lotus-eventkalender.firebaseapp.com",
  projectId: "red-lotus-eventkalender",
  storageBucket: "red-lotus-eventkalender.firebasestorage.app",
  messagingSenderId: "864967561482",
  appId: "1:864967561482:web:98ee51f304748e511f2af3"
});

const messaging = firebase.messaging();

// Push-Benachrichtigung anzeigen, wenn die App im Hintergrund ist / nicht offen ist.
messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || "Red Lotus Kalender";
  const body = (payload.notification && payload.notification.body) || "";
  self.registration.showNotification(title, {
    body,
    icon: "icon-192.png" // vorhandenes App-Icon, falls anderer Dateiname: hier anpassen
  });
});

// Klick auf die Benachrichtigung öffnet den Kalender.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow("https://felixvonheyking-collab.github.io/Event-Kalender-red-lotus/")
  );
});
