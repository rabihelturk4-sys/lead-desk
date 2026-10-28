/* Keeps the app shell available offline; lead data is cached by Firestore itself. */
const CACHE = 'lead-desk-v42';
const SHELL = ['./', 'index.html', 'config.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  /* network first so updates arrive at once; cache when offline */
  /* the page itself skips the browser cache, so a new version shows on the next open */
  const req = e.request.mode === 'navigate' || u.pathname.endsWith('.html') || u.pathname.endsWith('/') ? true : false;
  e.respondWith((req ? fetch(e.request.url, {cache: 'no-store', credentials: 'same-origin'}) : fetch(e.request)).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
});
/* Tapping a "new lead" notification opens Lead Desk */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(cs => {
    if (!cs.length) return self.clients.openWindow(url);
    return (url.includes('lead=') && cs[0].navigate ? cs[0].navigate(url) : Promise.resolve(cs[0])).then(c => (c || cs[0]).focus());
  }));
});
/* Background alert from the GitHub check (Firebase Cloud Messaging, data only) */
self.addEventListener('push', e => {
  let d = {}; try { const j = e.data.json(); d = j.data || j; } catch (x) { d = {body: e.data && e.data.text()}; }
  e.waitUntil(self.registration.showNotification(d.title || 'Lead Desk', {body: d.body || 'New lead', icon: 'icon-192.png', badge: 'icon-192.png', tag: 'newlead', renotify: true, data: {url: d.url || './'}}));
});
