"use strict";

const version = "daily-listening-v2-";
const cacheName = version + self.registration.scope;
const paths = ["./", "index.html", "app.js?v=2", "style.css?v=2", "icon.png", "manifest.webmanifest"];
const files = new Set(paths.map((path) => new URL(path, self.registration.scope).href));

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll([...files])));
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("daily-listening-v") && key.endsWith(self.registration.scope) && key !== cacheName) {
        await caches.delete(key);
      }
    }
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || !files.has(request.url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      else if (request.mode === "navigate") return (await cache.match(request)) ?? response;
      return response;
    } catch {
      return (await cache.match(request)) ?? Response.error();
    }
  })());
});
