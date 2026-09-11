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

/** True only when this page came from a developer machine on the local network. */
export const diagnosticsActive = isLocalDev

/**
 * Ship a whole session back: the beat grid, every detection with its features, the
 * accelerometer trace, and optionally the raw audio.
 *
 * Aggregates were not enough. Percentiles and counts told me detection "looked poor"
 * but not WHY, and every conclusion drawn from them so far has needed correcting. This
 * sends the events themselves so the same detector can be re-run offline against the
 * room she actually plays in.
 */
export async function sendSession (session, wavBlob) {
  if (!isLocalDev) return
  try {
    await fetch('/diag-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(session),
    })
    if (wavBlob) {
      await fetch('/diag-audio?id=' + encodeURIComponent(session.id), {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: wavBlob,
      })
    }
  } catch { /* the laptop isn't listening */ }
}

/** 16-bit WAV: half the bytes of float32 and plenty of range for this. */
export function wavFromFloat (pcm, rate) {
  const buf = new ArrayBuffer(44 + pcm.length * 2)
  const v = new DataView(buf)
  const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE')
  str(12, 'fmt '); v.setUint32(16, 16, true)
  v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  str(36, 'data'); v.setUint32(40, pcm.length * 2, true)
  for (let i = 0; i < pcm.length; i++) {
    const x = Math.max(-1, Math.min(1, pcm[i]))
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true)
  }
  return new Blob([buf], { type: 'audio/wav' })
}

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
