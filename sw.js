/* Tide Pool service worker — NETWORK-FIRST app shell with cache fallback.
   Online play always gets the latest deployed version after a single reload;
   the cache exists purely so the game still opens offline. */
var CACHE_NAME = "tide-pool-v14";   // v14: rescue uses the lose wave badge

var LOCAL_ASSETS = [
  "./",
  "index.html",
  "css/style.css",
  "js/game.js",
  "js/sound.js",
  "js/economy.js",
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
  var url = e.request.url;
  var isFont = url.indexOf("https://fonts.gstatic.com/") === 0 ||
               url.indexOf("https://fonts.googleapis.com/") === 0;
  var isLocal = url.indexOf(self.location.origin) === 0;

  // Fonts: cache-first (immutable, and network-first would slow every load).
  if (isFont) {
    e.respondWith(
      caches.match(e.request, { ignoreVary: true }).then(function (hit) {
        return hit || fetch(e.request).then(function (res) {
          var clone = res.clone();
          caches.open(CACHE_NAME).then(function (c) { c.put(e.request, clone); });
          return res;
        });
      })
    );
    return;
  }
  if (!isLocal) return;

  // App shell: network-first so a deploy reaches players on their next reload;
  // fall back to the cached copy when offline.
  e.respondWith(
    fetch(e.request).then(function (res) {
      if (res && res.ok) {
        var clone = res.clone();
        caches.open(CACHE_NAME).then(function (c) { c.put(e.request, clone); });
      }
      return res;
    }).catch(function () {
      return caches.match(e.request, { ignoreVary: true });
    })
  );
});
