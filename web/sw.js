// Offline cache for ps3xport.
//
// Everything the page needs is static, so the service worker makes the app
// work without a network connection and allows browsers to install it as an
// app. Archive data never goes through the service worker: it is read and
// written through the File System Access API.

const VERSION = 'ps3xport-v2';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './ui.js',
  './engine.js',
  './worker.js',
  './vfs.js',
  './layout.js',
  './writer.js',
  './zip.js',
  './pxfs.js',
  './host-directory.js',
  './host-remote.js',
  './sync-bridge.js',
  './ps3xport.mjs',
  './ps3xport.wasm',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './LICENSE',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(ASSETS.map(path => new URL(path, self.registration.scope).href));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== VERSION).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch (error) {
      if (request.mode === 'navigate') {
        const fallback = await cache.match(new URL('./index.html', self.registration.scope).href);
        if (fallback) return fallback;
      }
      throw error;
    }
  })());
});
