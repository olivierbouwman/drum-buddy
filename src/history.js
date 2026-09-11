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

import { key as playerKey } from './players.js'

const BASE = 'drum-practice.scores.v1'
const CAP = 500

/** Scores belong to a person, not to the tablet — see players.js. */
const KEY = () => playerKey(BASE)

const sameDay = (a, b) => {
  const x = new Date(a)
  const y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() &&
         x.getDate() === y.getDate()
}

export function load () {
  try {
    const raw = localStorage.getItem(KEY())
    if (!raw) return []
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((e) => typeof e.score === 'number') : []
  } catch {
    return []
  }
}

function save (list) {
  try {
    localStorage.setItem(KEY(), JSON.stringify(list.slice(-CAP)))
  } catch { /* nothing here is worth interrupting her for */ }
}

/**
 * Record an attempt and report how it compares.
 * @returns {{previous:number|null, bestToday:number, bestEver:number,
 *            isBestEver:boolean, isBestToday:boolean, recent:number[], attemptsToday:number}}
 */
export function record ({ score, exercise, bpm, spreadMs, level }) {
  const list = load()
  const previous = list.length ? list[list.length - 1].score : null

  const now = Date.now()
  const todayBefore = list.filter((e) => sameDay(e.at, now))
  const bestTodayBefore = todayBefore.length ? Math.max(...todayBefore.map((e) => e.score)) : 0
  const bestEverBefore = list.length ? Math.max(...list.map((e) => e.score)) : 0

  // spreadMs is stored alongside the score because it, not the score, is what says how
  // well she is actually playing — the score also moves with tempo and exercise choice.
  list.push({ score, at: now, exercise, bpm, spreadMs, level })
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

/** Her recent steadiness, newest last. Used to decide when to change level. */
export function recentSpreads (n = 5) {
  return load()
    .map((e) => e.spreadMs)
    .filter((v) => typeof v === 'number' && v > 0)
    .slice(-n)
}

/** How many attempts since the level last changed, for hysteresis. */
export function attemptsAtLevel (levelId) {
  const list = load()
  let count = 0
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].level !== levelId) break
    count++
  }
  return count
}

/**
 * How many days in a row she has practised, and how many days in total.
 *
 * A streak is the strongest pull back tomorrow there is, so it is worth having — but it
 * only counts a day once she has FINISHED a session, and today never breaks it. A child
 * should not lose fourteen days because she opened the app at bedtime and stopped.
 */
export function days () {
  const list = load()
  if (!list.length) return { streak: 0, total: 0, practisedToday: false }

  const dayKey = (t) => {
    const d = new Date(t)
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
  }
  const keys = [...new Set(list.map((e) => dayKey(e.at)))]
  const now = Date.now()
  const today = dayKey(now)
  const yesterday = dayKey(now - 864e5)
  const practisedToday = keys.includes(today)

  // Count back from today, or from yesterday if today has not happened yet — so the
  // streak only breaks after a day is genuinely missed, not part-way through one.
  let cursor = practisedToday ? now : now - 864e5
  let streak = 0
  if (practisedToday || keys.includes(yesterday)) {
    while (keys.includes(dayKey(cursor))) {
      streak++
      cursor -= 864e5
    }
  }
  return { streak, total: keys.length, practisedToday }
}

export function clear () {
  try { localStorage.removeItem(KEY()) } catch {}
}
