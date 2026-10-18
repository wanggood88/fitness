var CACHE = 'fit-v6';
var ASSETS = ['./', './index.html', './icon-180.png', './icon-512.png', './manifest.json', './demo.js',
  './voice/ten.m4a', './voice/three.m4a', './voice/two.m4a', './voice/one.m4a',
  './voice/go.m4a', './voice/rest.m4a', './voice/done.m4a',
  './media/squat.mp4', './media/pushup.gif', './media/crunch.gif', './media/jumpingjacks.gif', './media/lunge.gif', './media/highknees.gif'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (ks) {
      return Promise.all(ks.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      if (hit) return hit;
      return fetch(e.request).then(function (res) {
        if (res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        }
        return res;
      }).catch(function () { return caches.match('./index.html'); });
    })
  );
});
