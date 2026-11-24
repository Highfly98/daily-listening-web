"use strict";

const version = "daily-listening-v3-";
const cacheName = version + self.registration.scope;
const paths = ["./", "index.html", "app.js?v=3", "style.css?v=3", "icon.png", "manifest.webmanifest"];
const files = new Set(paths.map((path) => new URL(path, self.registration.scope).href));
const voiceFiles = new Set([
  "flite-worker.js", "voice/wasi/index.js", "voice/wasi/fs_mem.js",
  "voice/wasi/fs_opfs.js", "voice/wasi/wasi.js", "voice/wasi/fd.js",
  "voice/wasi/debug.js", "voice/wasi/strace.js", "voice/wasi/wasi_defs.js",
  "https://unpkg.com/@echogarden/flite-wasi@0.1.1/flite.wasm"
].map((path) => new URL(path, self.registration.scope).href));

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
  if (request.method !== "GET" || (!files.has(request.url) && !voiceFiles.has(request.url))) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    if (voiceFiles.has(request.url)) {
      const saved = await cache.match(request);
      if (saved) return saved;
    }
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone()).catch(() => {});
      else if (request.mode === "navigate") return (await cache.match(request)) ?? response;
      return response;
    } catch {
      return (await cache.match(request)) ?? Response.error();
    }
  })());
});
