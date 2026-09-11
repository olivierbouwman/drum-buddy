/**
 * Minimal service worker.
 *
 * Two reasons it exists. Chrome will not offer to install a site as an app without one,
 * and an installed app is the only reliable way to get a genuinely immersive window on
 * Android — the Fullscreen API was granted and still left the tab strip, status bar and
 * navigation bar in place. Second, it means she can practise with no wifi.
 *
 * Network first, cache as a fallback: always the current version when online, and the
 * last known good one when not. A cache-first worker would quietly pin her to an old
 * build, which on this project would be a slow and confusing way to lose an afternoon.
 */
const CACHE = 'drum-buddy-v1'

self.addEventListener('install', (e) => {
  self.skipWaiting()
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', './index.html']).catch(() => {})))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone()
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {})
        return res
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  )
})
