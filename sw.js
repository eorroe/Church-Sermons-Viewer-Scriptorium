const CACHE_NAME = 'scriptorium-v1';
const META_CACHE = 'scriptorium-meta';
const APP_SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  'https://cdn.tailwindcss.com',
  'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=Crimson+Pro:ital,wght@0,400;0,600;1,400&display=swap',
  'https://cdn.jsdelivr.net/npm/marked/marked.min.js'
];

const TTL_MS = 168 * 60 * 60 * 1000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(
        APP_SHELL.map((url) => cache.add(url))
      );
    }).then((results) => {
      results.forEach((result) => {
        if (result.status === 'rejected') {
          console.warn('Failed to cache asset:', result.reason);
        }
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME && key !== META_CACHE)
          .map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

async function getMeta(url) {
  try {
    const metaCache = await caches.open(META_CACHE);
    const response = await metaCache.match(url);
    if (response) {
      const meta = await response.json();
      return meta;
    }
  } catch (e) {
    console.error('Failed to get cache meta:', e);
  }
  return null;
}

async function setMeta(url, timestamp) {
  try {
    const metaCache = await caches.open(META_CACHE);
    const response = new Response(JSON.stringify({ url, timestamp }));
    await metaCache.put(url, response);
  } catch (e) {
    console.error('Failed to set cache meta:', e);
  }
}

async function isCacheStale(url) {
  const meta = await getMeta(url);
  if (!meta) return true;
  return Date.now() - meta.timestamp > TTL_MS;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;

  if (url.hostname === 'api.github.com' || url.hostname === 'raw.githubusercontent.com') {
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cachedResponse = await cache.match(request);

      if (!navigator.onLine) {
        return cachedResponse || new Response('Offline - No Cached Data', { status: 503 });
      }

      if (cachedResponse && !(await isCacheStale(request.url))) {
        return cachedResponse;
      }

      try {
        const networkResponse = await fetch(request);
        if (networkResponse.ok) {
          await cache.put(request, networkResponse.clone());
          await setMeta(request.url, Date.now());
        }
        return networkResponse;
      } catch (error) {
        return cachedResponse || new Response('Offline - No Cached Data', { status: 503 });
      }
    })()
  );
});