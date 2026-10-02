// Telefon bildirimleri (Firebase Cloud Messaging). Sunucu "notification"
// iceren mesaj gonderdiginde SDK bildirimi kendisi gosterir ve tiklaninca
// fcmOptions.link'i acar (bkz. functions/index.js vekilDersBildirimi).
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');
firebase.initializeApp({
  apiKey: 'AIzaSyAHTCiicd4b94rG1-jN0STRbwcrLmkYudo',
  authDomain: 'okul-yoklama-sistemi-8081f.firebaseapp.com',
  projectId: 'okul-yoklama-sistemi-8081f',
  storageBucket: 'okul-yoklama-sistemi-8081f.firebasestorage.app',
  messagingSenderId: '38230047763',
  appId: '1:38230047763:web:dfab058df8928b66be13e6',
});
firebase.messaging();

const CACHE = 'okul-pwa-v3';
const STATIK = [
  '/portal.html',
  '/portal.css',
  '/js/portal-raporlar.js',
  '/js/portal-ayarlar.js',
  '/icon.svg',
  '/manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(STATIK)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = e.request.url;
  // Firebase, fonts ve external CDN'leri atlat
  if (url.includes('firebase') || url.includes('googleapis') || url.includes('cdnjs') || url.includes('fonts.g')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res && res.status === 200 && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
