self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  return self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Pass-through fetch for everything (no caching)
  event.respondWith(fetch(event.request));
});
