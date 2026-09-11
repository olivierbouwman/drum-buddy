/**
 * Score history, kept on the device.
 *
 * Deliberately small: an append-only list of {score, at, exercise, bpm}, capped, in
 * localStorage. No account, nothing leaves the device, and it degrades to "no history"
 * without complaint if storage is unavailable (private windows, cleared site data, a
 * browser set to block it).
 *
 * What it is for is comparison, not record-keeping — "better than last time" and "best
 * today" are the two facts that actually motivate a practice session. Best-ever is
 * shown too, but only when it isn't today's, so a good day doesn't get overshadowed by
 * a better one months ago.
 */

const KEY = 'drum-practice.scores.v1'
const CAP = 500

const sameDay = (a, b) => {
  const x = new Date(a)
  const y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() &&
         x.getDate() === y.getDate()
}

export function load () {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((e) => typeof e.score === 'number') : []
  } catch {
    return []
  }
}

function save (list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-CAP)))
  } catch { /* nothing here is worth interrupting her for */ }
}

/**
 * Record an attempt and report how it compares.
 * @returns {{previous:number|null, bestToday:number, bestEver:number,
 *            isBestEver:boolean, isBestToday:boolean, recent:number[], attemptsToday:number}}
 */
export function record ({ score, exercise, bpm }) {
  const list = load()
  const previous = list.length ? list[list.length - 1].score : null

  const now = Date.now()
  const todayBefore = list.filter((e) => sameDay(e.at, now))
  const bestTodayBefore = todayBefore.length ? Math.max(...todayBefore.map((e) => e.score)) : 0
  const bestEverBefore = list.length ? Math.max(...list.map((e) => e.score)) : 0

  list.push({ score, at: now, exercise, bpm })
  save(list)

  return {
    previous,
    bestToday: Math.max(bestTodayBefore, score),
    bestEver: Math.max(bestEverBefore, score),
    // A first-ever attempt is not a record; there is nothing to have beaten.
    isBestEver: list.length > 1 && score > bestEverBefore,
    isBestToday: todayBefore.length > 0 && score > bestTodayBefore,
    recent: list.slice(-14).map((e) => e.score),
    attemptsToday: todayBefore.length + 1,
  }
}

export function clear () {
  try { localStorage.removeItem(KEY) } catch {}
}
