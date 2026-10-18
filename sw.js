var CACHE = 'fit-v21';
var ASSETS = ['./', './index.html', './icon-180.png', './icon-512.png', './manifest.json', './demo.js', './three.min.js', './demo3d.js', './music.js?v=2',
  './voice/ten.m4a', './voice/three.m4a', './voice/two.m4a', './voice/one.m4a',
  './voice/go.m4a', './voice/rest.m4a', './voice/done.m4a',
  './splash/splash_750x1334.png', './splash/splash_1125x2436.png', './splash/splash_1170x2532.png', './splash/splash_1179x2556.png', './splash/splash_1284x2778.png', './splash/splash_1290x2796.png', './splash/splash_1206x2622.png', './splash/splash_1320x2868.png',
  './splash/splash_1334x750.png', './splash/splash_2436x1125.png', './splash/splash_2532x1170.png', './splash/splash_2556x1179.png', './splash/splash_2778x1284.png', './splash/splash_2796x1290.png', './splash/splash_2622x1206.png', './splash/splash_2868x1320.png'];

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
