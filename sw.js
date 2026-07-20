/* Tide Pool service worker — cache-first app shell for offline play.
   Bump CACHE_NAME on every deploy to invalidate the old shell. */
var CACHE_NAME = "tide-pool-v1";

var LOCAL_ASSETS = [
  "./",
  "index.html",
  "css/style.css",
  "js/game.js",
  "js/sound.js",
  "js/levels.js",
  "js/hint-worker.js",
  "src/rng.js",
  "src/logic.js",
  "src/solver.js",
  "src/generator.js",
  "manifest.webmanifest",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-512.png"
];

var FONT_CSS =
  "https://fonts.googleapis.com/css2?family=Quicksand:wght@500;600;700&family=Nunito+Sans:wght@400;600;700;800&display=swap";

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function (c) {
      return c.addAll(LOCAL_ASSETS).then(function () {
        return c.add(new Request(FONT_CSS, { mode: "no-cors" })).catch(function () {});
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE_NAME; })
            .map(function (k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request, { ignoreVary: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(e.request).then(function (res) {
        var url = e.request.url;
        var cacheable =
          res &&
          (res.ok || res.type === "opaque") &&
          (url.indexOf(self.location.origin) === 0 ||
           url.indexOf("https://fonts.gstatic.com/") === 0 ||
           url.indexOf("https://fonts.googleapis.com/") === 0);
        if (cacheable) {
          var clone = res.clone();
          caches.open(CACHE_NAME).then(function (c) { c.put(e.request, clone); });
        }
        return res;
      }).catch(function () { return hit; });
    })
  );
});
