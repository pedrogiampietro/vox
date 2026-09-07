// O service worker existe para habilitar a instalação como aplicativo.
// Deixamos a rede controlar os arquivos para não prender versões antigas.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => event.respondWith(fetch(event.request)));
