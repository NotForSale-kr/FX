// 오프라인에서도 앱이 열리도록 앱 파일만 저장
const C = "fx-lite-1", FILES = ["./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png"];
self.oninstall = e => { self.skipWaiting(); e.waitUntil(caches.open(C).then(c => c.addAll(FILES))); };
self.onactivate = e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))));
self.onfetch = e => {
  if (new URL(e.request.url).origin !== location.origin) return;   // 환율 요청은 그대로 통과
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(C).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match("./"))));
};
