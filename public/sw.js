const C = "dp-v1";
const SHELL = ["/", "/manifest.json", "/icon.svg", "/icon-192.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(C).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== C).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Netz zuerst, Cache als Offline-Fallback. /api/ nie cachen.
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(C).then(c => c.put(req, copy)).catch(() => {}); }
        return res;
      })
      .catch(() => caches.match(req).then(m => m || (req.mode === "navigate" ? caches.match("/") : Response.error())))
  );
});

self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(
    self.registration.showNotification(d.title || "Das Programm", {
      body: d.body || "Neuer Eintrag",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: d.tag || "dp",
      renotify: true,
      data: { url: d.url || "/" },
    }).then(() => self.clients.matchAll({ type: "window" }).then(ws => ws.forEach(w => w.postMessage("refresh"))))
  );
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || "/", location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(ws => {
      for (const w of ws) if ("focus" in w) return w.focus();
      return self.clients.openWindow(target);
    })
  );
});
