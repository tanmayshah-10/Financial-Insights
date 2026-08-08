// Minimal offline shell. App data lives in Supabase; this just caches the shell.
const CACHE = 'spend-insights-v1';
const ASSETS = ['./','./index.html','./css/theme.css','./css/app.css','./js/app.js','./manifest.webmanifest'];
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(()=>{})); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k))))); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;                 // never cache Supabase/CDN calls
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request).then(r => r || caches.match('./index.html'))));
});
