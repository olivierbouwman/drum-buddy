/**
 * Who is playing.
 *
 * Two reasons this earns its place. Progress is personal — her ladder position, tempo
 * and scores should not move because someone else had a go — and there needs to be a
 * way to try the app without polluting her record, which is what Guest is for.
 *
 * What is stored per PLAYER and what is stored per DEVICE differ, and the split matters:
 * scores, level and progress belong to the person, while the measured latency and the
 * pad's sensor delay are properties of this tablet on this pad and are shared by
 * everyone who uses it.
 */

const PLAYERS_KEY = 'drum-practice.players.v1'
const CURRENT_KEY = 'drum-practice.currentPlayer.v1'

export const GUEST = { id: 'guest', name: 'Guest', emoji: '👤', guest: true }

/** Animals only, and every one checked to render on the devices she uses. */
export const AVATARS = [
  '🦦', '🦊', '🐻', '🦫', '🦔', '🐭', '🐸', '🐨',
  '🦉', '🐧', '🦁', '🐯', '🐼', '🐰', '🦄', '🐢',
]

const read = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch { return fallback }
}
const write = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage off */ }
}

export function list () {
  const v = read(PLAYERS_KEY, [])
  return Array.isArray(v) ? v.filter((p) => p && p.id && p.name) : []
}

export function current () {
  const id = read(CURRENT_KEY, null)
  if (id === GUEST.id) return GUEST
  const found = list().find((p) => p.id === id)
  return found || list()[0] || GUEST
}

export function setCurrent (id) {
  write(CURRENT_KEY, id)
  return current()
}

export function create (name, emoji) {
  const clean = String(name || '').trim().slice(0, 14) || 'Drummer'
  const player = {
    id: 'p' + Date.now().toString(36),
    name: clean,
    emoji: emoji || AVATARS[0],
  }
  const all = list()
  all.push(player)
  write(PLAYERS_KEY, all)
  write(CURRENT_KEY, player.id)
  return player
}

export function remove (id) {
  write(PLAYERS_KEY, list().filter((p) => p.id !== id))
  if (read(CURRENT_KEY, null) === id) write(CURRENT_KEY, null)
}

/** Storage key for something that belongs to this player rather than this device. */
export function key (base) {
  return `${base}:${current().id}`
}
