/**
 * Scoring tests.
 *
 * The single most important thing in this repo is that the app never tells her the
 * opposite of the truth. A sign error here would teach her to correct in exactly the
 * wrong direction, and it would look completely plausible on screen. So the sign
 * convention is asserted first and explicitly:
 *
 *     errorMs = hit time - note time
 *     negative -> she hit EARLY  -> 🐰 quick
 *     positive -> she hit LATE   -> 🐢 slow
 */

import { LiveScorer, summarise, matchInOrder, captureWindow } from '../src/scoring.js'
import { WINDOWS } from '../src/config.js'

let passed = 0
let failed = 0

function check (name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`) }
  else { failed++; console.log(`  FAIL ${name}${detail ? '  <- ' + detail : ''}`) }
}
const near = (a, b, tol = 0.001) => Math.abs(a - b) <= tol

const BEAT = 1.0 // 60 bpm
const notes = (n, start = 10) =>
  Array.from({ length: n }, (_, i) => ({ index: i, time: start + i * BEAT, hand: i % 2 ? 'L' : 'R' }))
const hitsAt = (ns, offsetMs) => ns.map((n) => ({ time: n.time + offsetMs / 1000, strength: 1 }))

console.log('\nsign convention')
{
  const ns = notes(4)
  const s = new LiveScorer(BEAT)
  ns.forEach((n) => s.addNote(n))
  const late = s.feed({ time: ns[0].time + 0.05 })
  check('hitting 50ms after the beat reports +50 (late)', near(late.errorMs, 50, 0.01), `got ${late.errorMs}`)
  const early = s.feed({ time: ns[1].time - 0.03 })
  check('hitting 30ms before the beat reports -30 (early)', near(early.errorMs, -30, 0.01), `got ${early.errorMs}`)
  const exact = s.feed({ time: ns[2].time })
  check('hitting exactly on the beat reports 0', near(exact.errorMs, 0, 0.01), `got ${exact.errorMs}`)
  check('exact hit is graded perfect', exact.kind === 'perfect')
}

console.log('\nknown offsets round-trip through summarise')
for (const off of [+37, -22, 0, +80, -65]) {
  const ns = notes(16)
  const st = summarise(ns, hitsAt(ns, off), BEAT)
  check(`offset ${off > 0 ? '+' : ''}${off}ms -> median ${off}`, near(st.offsetMs, off, 0.01), `got ${st.offsetMs}`)
  check(`offset ${off}ms -> spread ~0`, st.spreadMs < 0.01, `got ${st.spreadMs}`)
}

console.log('\nlean naming matches the sign')
{
  const ns = notes(16)
  check('consistently early is called quick (rabbit)', summarise(ns, hitsAt(ns, -90), BEAT).lean === 'quick')
  check('consistently late is called slow (turtle)', summarise(ns, hitsAt(ns, +90), BEAT).lean === 'slow')
  check('small lean is not flagged at all', summarise(ns, hitsAt(ns, -25), BEAT).lean === 'even')
}

console.log('\nsteadiness is independent of offset')
{
  const ns = notes(16)
  const jitter = [12, -9, 4, -14, 7, -3, 11, -8, 2, -11, 6, -5, 13, -7, 1, -10]
  const centred = ns.map((n, i) => ({ time: n.time + jitter[i] / 1000 }))
  const shifted = ns.map((n, i) => ({ time: n.time + (jitter[i] + 200) / 1000 }))
  const a = summarise(ns, centred, BEAT)
  const b = summarise(ns, shifted, BEAT)
  check('same jitter, different offset -> same spread',
    near(a.spreadMs, b.spreadMs, 0.5), `${a.spreadMs} vs ${b.spreadMs}`)
}

console.log('\nthe big one: a late player is never reported as perfect')
{
  // Nearly a whole beat late. A naive nearest-neighbour matcher pairs each hit with
  // the FOLLOWING note, reports ~0 error, and congratulates her.
  const ns = notes(16)
  const st = summarise(ns, hitsAt(ns, 950), BEAT)
  check('whole-beat lag is detected and flagged', st.shift !== 0, `shift=${st.shift}`)
  check('whole-beat lag does not report a tiny offset',
    !(Math.abs(st.offsetMs) < 100 && st.matched > 8),
    `offset=${st.offsetMs} matched=${st.matched}`)
}

console.log('\ngood playing is never called displaced')
{
  // Reproduces a real session: every note hit accurately, plus a burst of extra notes
  // played during the count-in. The guard used to declare this a whole beat out and
  // throw the score away.
  const ns = notes(32)
  const played = ns.map((n) => ({ time: n.time + (Math.random() * 0.04 - 0.02) }))
  const countInNoodling = [-3.2, -2.8, -2.4, -2.0, -1.6, -1.2, -0.8, -0.5, -0.3, -0.15, -0.05, 0.4, 0.9]
    .map((d) => ({ time: ns[0].time + d }))
  const all = [...countInNoodling, ...played].sort((a, b) => a.time - b.time)
  const st = summarise(ns, all, BEAT)
  check('extra hits before the first note do not fake a whole-beat shift', st.shift === 0,
    `shift=${st.shift}`)
  check('a well-played take still gets a score', st.enough, `enough=${st.enough}`)
  check('and still reports a small offset', Math.abs(st.offsetMs) < 60, `${st.offsetMs.toFixed(0)} ms`)
}

console.log('\nplaying far off the beat is named, not met with silence')
{
  // Reproduces a deliberate test run: steady playing about half a beat late. The app
  // correctly refused to score it, and then said nothing at all.
  const ns = notes(32)
  const late = ns.map((n) => ({ time: n.time + 0.44 + (Math.random() * 0.06 - 0.03) }))
  const st = summarise(ns, late, BEAT)
  check('does not pretend she was accurate', !st.enough || Math.abs(st.offsetMs) > 200)
  check('notices she was far off', st.farOff !== null, JSON.stringify(st.farOff))
  check('names the direction correctly', st.farOff && st.farOff.direction === 'late',
    st.farOff && st.farOff.direction)

  const early = ns.map((n) => ({ time: n.time - 0.40 + (Math.random() * 0.06 - 0.03) }))
  const st2 = summarise(ns, early, BEAT)
  check('and the other direction too', st2.farOff && st2.farOff.direction === 'early',
    st2.farOff && st2.farOff.direction)

  // Ordinary good playing must not be labelled far off.
  const fine = ns.map((n) => ({ time: n.time + (Math.random() * 0.08 - 0.04) }))
  check('good playing is never called far off', summarise(ns, fine, BEAT).farOff === null)
}

console.log('\nmatching stays in order')
{
  const ns = notes(6)
  const { pairs } = matchInOrder(ns, hitsAt(ns, 60), captureWindow(BEAT))
  const crossing = pairs.some((p, i) => i > 0 && p.hit.time < pairs[i - 1].hit.time)
  check('pairings never cross', !crossing)
  check('every note paired once', pairs.length === 6)
  const indices = pairs.map((p) => p.note.index)
  check('note order preserved', indices.every((v, i) => v === i))
}

console.log('\nmisses and extras')
{
  const ns = notes(8)
  const played = [ns[0], ns[1], ns[4], ns[5]].map((n) => ({ time: n.time }))
  const st = summarise(ns, played, BEAT)
  check('missed notes counted', st.missed === 4, `got ${st.missed}`)
  check('coverage reported', near(st.coverage, 0.5, 0.001), `got ${st.coverage}`)

  const noisy = [...hitsAt(ns, 0), { time: ns[0].time + 0.45 }, { time: ns[3].time + 0.4 }]
    .sort((a, b) => a.time - b.time)
  const st2 = summarise(ns, noisy, BEAT)
  check('spurious hits do not corrupt the offset', near(st2.offsetMs, 0, 1), `got ${st2.offsetMs}`)
  check('spurious hits are counted as extras', st2.extras === 2, `got ${st2.extras}`)
}

console.log('\ntempo drift is detected')
{
  const ns = notes(16)
  // Creeping 6 ms earlier each note = speeding up.
  const rushing = ns.map((n, i) => ({ time: n.time - (i * 6) / 1000 }))
  const st = summarise(ns, rushing, BEAT)
  check('speeding up gives a negative drift slope', st.driftMsPerNote < -4, `got ${st.driftMsPerNote}`)
  const dragging = ns.map((n, i) => ({ time: n.time + (i * 6) / 1000 }))
  check('slowing down gives a positive drift slope',
    summarise(ns, dragging, BEAT).driftMsPerNote > 4)
}

console.log('\nwindows and streaks')
{
  const ns = notes(10)
  const s = new LiveScorer(BEAT)
  ns.forEach((n) => s.addNote(n))
  ns.slice(0, 5).forEach((n) => s.feed({ time: n.time + 0.01 }))
  check('good hits build a streak', s.streak === 5, `got ${s.streak}`)
  s.feed({ time: ns[5].time + (WINDOWS.almost + 40) / 1000 })
  check('a bad hit resets the streak', s.streak === 0, `got ${s.streak}`)
  check('best streak is remembered', s.bestStreak === 5, `got ${s.bestStreak}`)
}

console.log('\ncapture window is bounded')
{
  check('window never exceeds 250ms even at slow tempos', captureWindow(2.0) === 250)
  check('window is half a beat at fast tempos', near(captureWindow(0.3), 150))
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
