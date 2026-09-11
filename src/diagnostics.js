/**
 * Sends what the app is seeing back to a developer machine on the same network.
 *
 * Only ever active when the app is being served from that machine's dev server — the
 * published build on GitHub Pages has no endpoint to talk to and sends nothing. This
 * exists because the tablet is supervised by Family Link, which blocks developer
 * options and therefore adb, so its browser cannot be inspected directly.
 *
 * What goes over the wire is measurements: levels, latencies, band margins, counts.
 * Never audio, and never off the local network.
 */

const isLocalDev = !/github\.io$/.test(location.hostname) && location.port !== ''

export function startDiagnostics (getSnapshot, { everyMs = 4000 } = {}) {
  if (!isLocalDev) return () => {}

  let lastSent = ''
  const send = async (reason) => {
    try {
      const snap = { reason, ...getSnapshot() }
      // Skip identical payloads so an idle screen doesn't fill the log.
      const key = JSON.stringify({ ...snap, when: null, reason: null })
      if (key === lastSent && reason === 'tick') return
      lastSent = key
      await fetch('/diag', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(snap),
        keepalive: true,
      })
    } catch { /* the laptop isn't listening; not her problem */ }
  }

  const timer = setInterval(() => send('tick'), everyMs)
  document.addEventListener('visibilitychange', () => { if (document.hidden) send('hidden') })
  window.addEventListener('pagehide', () => send('leaving'))

  send('start')
  return { send, stop: () => clearInterval(timer) }
}
