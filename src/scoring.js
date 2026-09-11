/**
 * Turning hits into feedback.
 *
 * Two jobs, deliberately separate:
 *   LiveScorer  - instant per-hit verdict while she plays
 *   summarise() - the end-of-exercise numbers, computed properly over everything
 *
 * The one thing this file must never do is quietly pair a hit with the wrong beat.
 * A naive nearest-neighbour matcher, given a child playing consistently very late,
 * starts matching each hit to the FOLLOWING beat — and then reports her as perfect.
 * Hence order-preserving matching plus an explicit whole-beat-shift check.
 */

import { WINDOWS, STEADINESS } from './config.js'

const median = (xs) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Robust spread. MAD scaled to be comparable with a standard deviation. */
const madSpread = (xs) => {
  if (xs.length < 2) return 0
  const m = median(xs)
  return median(xs.map((x) => Math.abs(x - m))) * 1.4826
}

/** How wide a hit can be from a note and still count as that note. */
export const captureWindow = (beatS) => Math.min(0.5 * beatS * 1000, 250)

/**
 * Order-preserving match. Both sequences are monotonic in time, so pairings may never
 * cross. ~15 lines, and it is what stops the failure described at the top of the file.
 */
export function matchInOrder (notes, hits, windowMs) {
  const pairs = []
  const extras = []
  const missed = []
  let i = 0
  let j = 0
  while (i < notes.length && j < hits.length) {
    const d = (hits[j].time - notes[i].time) * 1000
    if (Math.abs(d) <= windowMs) {
      pairs.push({ note: notes[i], hit: hits[j], errorMs: d })
      i++; j++
    } else if (d < 0) {
      extras.push(hits[j]); j++          // hit arrived before this note's window
    } else {
      missed.push(notes[i]); i++         // note's window passed with nothing in it
    }
  }
  while (j < hits.length) extras.push(hits[j++])
  while (i < notes.length) missed.push(notes[i++])
  return { pairs, extras, missed }
}

/** Live, one hit at a time. Consumes notes in order and never looks backwards. */
export class LiveScorer {
  constructor (beatS) {
    this.windowMs = captureWindow(beatS)
    this.notes = []
    this.cursor = 0
    this.results = []
    this.streak = 0
    this.bestStreak = 0
    this.extras = 0
  }

  addNote (note) { this.notes.push(note) }

  /**
   * @returns {{note, errorMs, kind}|null} null when the hit matched no pending note
   */
  feed (hit) {
    // Retire notes whose window has definitively closed.
    while (
      this.cursor < this.notes.length &&
      (hit.time - this.notes[this.cursor].time) * 1000 > this.windowMs
    ) {
      this.results.push({ note: this.notes[this.cursor], errorMs: null })
      this.cursor++
      this.streak = 0
    }

    const note = this.notes[this.cursor]
    if (!note) { this.extras++; return null }

    const errorMs = (hit.time - note.time) * 1000
    if (Math.abs(errorMs) > this.windowMs) { this.extras++; return null }

    this.cursor++
    this.results.push({ note, errorMs })

    const a = Math.abs(errorMs)
    const kind = a <= WINDOWS.perfect ? 'perfect' : a <= WINDOWS.great ? 'great' : a <= WINDOWS.almost ? 'almost' : 'off'
    if (a <= WINDOWS.great) {
      this.streak++
      this.bestStreak = Math.max(this.bestStreak, this.streak)
    } else {
      this.streak = 0
    }
    return { note, errorMs, kind }
  }

  /** Close out any notes she never got to. */
  finish () {
    while (this.cursor < this.notes.length) {
      this.results.push({ note: this.notes[this.cursor], errorMs: null })
      this.cursor++
    }
  }
}

/**
 * End-of-exercise statistics.
 *
 * Steadiness leads, not accuracy. Spread doesn't depend on the latency calibration at
 * all, and anticipating the beat slightly is normal — for children especially, and
 * more so at slow tempos. Grading mainly on offset would label a perfectly normal
 * 8-year-old a rusher every single session.
 */
export function summarise (notes, hits, beatS) {
  const windowMs = captureWindow(beatS)
  const { pairs, extras, missed } = matchInOrder(notes, hits, windowMs)
  const errors = pairs.map((p) => p.errorMs)

  const offset = median(errors)
  const spread = madSpread(errors)

  // Drift: least-squares slope of error against note index, in ms per note.
  let drift = 0
  if (pairs.length >= 8) {
    const n = pairs.length
    const mx = (n - 1) / 2
    const my = errors.reduce((a, b) => a + b, 0) / n
    let num = 0
    let den = 0
    for (let k = 0; k < n; k++) {
      num += (k - mx) * (errors[k] - my)
      den += (k - mx) * (k - mx)
    }
    drift = den ? num / den : 0
  }
  // Negative slope = getting progressively earlier = speeding up.
  const notesPerBeat = notes.length / (notes.length ? (notes[notes.length - 1].time - notes[0].time) / beatS + 1 : 1)
  const effectiveBpm = drift ? (60 / beatS) / (1 + (drift / 1000) * notesPerBeat / beatS) : 60 / beatS

  const coverage = notes.length ? pairs.length / notes.length : 0
  const shift = detectWholeBeatShift(notes, hits, beatS)

  const band = STEADINESS.find((b) => spread < b.under) || STEADINESS[STEADINESS.length - 1]

  // When she is out by whole beats, the matcher's own offset is measured against the
  // WRONG notes and reads as a small, innocent-looking number. Report the real gap.
  const trueOffset = offset + shift * beatS * 1000

  return {
    matched: pairs.length,
    total: notes.length,
    coverage,
    extras: extras.length,
    missed: missed.length,
    offsetMs: trueOffset,
    spreadMs: spread,
    driftMsPerNote: drift,
    driftBpm: effectiveBpm,
    badge: band.badge,
    stars: coverage < 0.4 ? 1 : band.stars,
    // A displaced player has no meaningful lean; saying 'a bit quick' there would
    // be worse than saying nothing.
    lean: shift !== 0 ? 'shifted' : Math.abs(offset) < 40 ? 'even' : offset < 0 ? 'quick' : 'slow',
    shift,
    enough: pairs.length >= 6 && shift === 0,
  }
}

/**
 * Is she playing the right rhythm, but displaced by a whole beat?
 *
 * This is the failure the whole file is built around. Order-preserving matching alone
 * does NOT prevent it: with every hit a beat late, note 0 is simply marked missed and
 * hit 0 pairs with note 1, giving a small, plausible-looking error. The app would then
 * tell a child who is a whole beat behind that she is doing fine.
 *
 * It needs two signals together, because either alone gives false alarms:
 *
 *   1. Bulk displacement — the median hit time sits more than half a beat away from
 *      the median note time. Robust to a few extra or missing hits.
 *   2. The shifted alignment must cover STRICTLY more notes than the unshifted one.
 *      Without this, a child who simply starts four beats late looks displaced when
 *      in fact everything she played was fine.
 *
 * A hit 950 ms late at 60 BPM is only 50 ms before the next beat, so timing alone
 * genuinely cannot tell "very late" from "slightly early" — which is why the bulk
 * displacement of the whole sequence has to be part of the answer.
 */
function detectWholeBeatShift (notes, hits, beatS) {
  if (notes.length < 4 || hits.length < 4) return 0

  const tol = Math.min(0.25 * beatS, 0.12)
  const coverage = (offsetS) => {
    let c = 0
    for (const n of notes) {
      const target = n.time + offsetS
      if (hits.some((h) => Math.abs(h.time - target) <= tol)) c++
    }
    return c
  }

  /*
   * Only judge displacement when she played roughly the right NUMBER of notes.
   *
   * Being a whole beat out means playing the right rhythm in the wrong place, so the
   * counts still match. A pile of extra hits means something else entirely — and it
   * wrecks the median this test relies on.
   *
   * Measured on the real tablet: 32 of 32 notes matched with 30 ms of spread and a
   * 14-note streak, and the guard still declared her a whole beat ahead and threw the
   * score away. She had drummed through the count-in, and those thirteen extra hits
   * dragged the median far enough to trip a test that was never meant to fire on
   * playing that good. A false alarm here punishes a child for doing well, which is
   * worse than missing the rare genuine case — she can hear that one herself.
   */
  if (hits.length > notes.length * 1.15) return 0

  const atZero = coverage(0)
  const displacement = median(hits.map((h) => h.time)) - median(notes.map((n) => n.time))
  if (Math.abs(displacement) < 0.5 * beatS) return 0

  const shift = Math.round(displacement / beatS)
  if (shift === 0) return 0

  // Strictly better, not merely equal: a late starter ties, and is not displaced.
  return coverage(shift * beatS) > atZero ? shift : 0
}

/**
 * One number that sums up an attempt.
 *
 * Four separate statistics are more than an eight-year-old should have to synthesise.
 * A single score gives her something to beat, and something to watch move.
 *
 * Built out of, in order of weight:
 *   - STEADINESS, because it is the thing she is actually training and the only metric
 *     that does not depend on the latency calibration being right.
 *   - COVERAGE, squared, because otherwise the winning strategy is to play three notes
 *     beautifully and ignore the rest of the exercise.
 *   - BEST STREAK, as a flat bonus, because it is the part she cares about.
 *   - DIFFICULTY, as a multiplier on notes per minute, so the exercise ladder is worth
 *     climbing instead of the top score living forever on quarter notes at 60 BPM.
 *
 * Deliberately independent of the chosen fussiness level. That setting changes how
 * encouraging the words are, not how well she played, and a score that jumped when a
 * parent touched a setting would mean nothing.
 *
 * The 90 ms scale is a typical beginner's spread, so a normal attempt lands in the
 * hundreds and a good one in the high hundreds — big enough to feel like a score,
 * with room above.
 */
export function scoreFor (stats, notesPerMinute) {
  if (!stats.enough) return null

  const steadiness = 1000 * Math.exp(-Math.max(0, stats.spreadMs) / 90)
  const coverage = Math.pow(Math.max(0, Math.min(1, stats.coverage)), 2)
  const streakBonus = 10 * (stats.bestStreak || 0)
  const difficulty = Math.sqrt(Math.max(30, notesPerMinute) / 60)

  const raw = (steadiness * coverage + streakBonus) * difficulty
  return Math.max(0, Math.round(raw / 5) * 5)
}

/** Notes per minute an exercise asks for at a given tempo — the difficulty input. */
export function notesPerMinute (exercise, bpm) {
  return (exercise.notes.length / exercise.beatsPerBar) * bpm
}
