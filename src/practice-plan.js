/**
 * Builds today's five minutes.
 *
 * The shape is the same every day — warm up, work on one thing, finish on something she
 * can already do — because that is how a teacher structures a beginner's practice and
 * because the ritual itself is worth something at eight years old.
 *
 * What changes is the middle. A carousel showing something different daily feels richer
 * and teaches less: motor patterns form by doing the same thing across many days, so
 * the focus exercise stays put until it is genuinely steady. Variety comes from tempo
 * and from the last slot.
 *
 * Ending on something she is good at is deliberate twice over — it sends her away
 * having succeeded, and revisiting older material is how it consolidates.
 */

import { EXERCISES } from './exercises.js'
import { TEMPO, SESSION } from './config.js'

/** An exercise counts as solid after this many steady attempts. */
const ATTEMPTS_TO_PASS = 3
/** Spread, in ms, at or under which an attempt counts as steady for a beginner. */
const STEADY_MS = 70
/** Tempo only moves after this many steady attempts in a row at the current one. */
const ATTEMPTS_PER_STEP = 3

const median = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[s.length >> 1]
}

/** Everything the plan needs to know about how one exercise has been going. */
export function progressFor (history, id) {
  const runs = history.filter((h) => h.exercise === id && typeof h.spreadMs === 'number')
  const recent = runs.slice(-5)
  const steady = recent.filter((r) => r.spreadMs <= STEADY_MS)
  return {
    attempts: runs.length,
    recentSpread: median(recent.map((r) => r.spreadMs)),
    steadyRuns: steady.length,
    // Solid means repeatedly steady, not once lucky.
    solid: recent.length >= ATTEMPTS_TO_PASS && steady.length >= ATTEMPTS_TO_PASS,
    lastBpm: runs.length ? runs[runs.length - 1].bpm : null,
  }
}

/**
 * Tempo for an exercise: start slow, and move only on repeated success.
 *
 * Beginners always want to speed up, and speed is not the skill — evenness is. So this
 * is deliberately reluctant: a few steady attempts in a row buys 5 BPM.
 */
export function tempoFor (history, id, startBpm = TEMPO.default) {
  const runs = history.filter((h) => h.exercise === id && typeof h.spreadMs === 'number')
  if (!runs.length) return startBpm
  const current = runs[runs.length - 1].bpm || startBpm
  const atCurrent = runs.filter((r) => r.bpm === current).slice(-ATTEMPTS_PER_STEP)
  const allSteady = atCurrent.length >= ATTEMPTS_PER_STEP &&
    atCurrent.every((r) => r.spreadMs <= STEADY_MS)
  if (allSteady) return Math.min(TEMPO.max, current + TEMPO.step)
  // Struggling badly at this tempo for a while? Ease back rather than grind.
  const rough = atCurrent.length >= ATTEMPTS_PER_STEP &&
    atCurrent.every((r) => r.spreadMs > STEADY_MS * 1.6)
  if (rough) return Math.max(TEMPO.min, current - TEMPO.step)
  return current
}

/**
 * @param {Array} history entries from history.load()
 * @returns {{steps:Array, focusId:string, newFocus:boolean}}
 */
export function buildPlan (history) {
  const progress = Object.fromEntries(EXERCISES.map((e) => [e.id, progressFor(history, e.id)]))

  // The focus is the first thing in the ladder she has not made solid. The ladder is in
  // teaching order, so this walks her up it without ever skipping a step.
  const focus = EXERCISES.find((e) => !progress[e.id].solid) || EXERCISES[EXERCISES.length - 1]

  const solid = EXERCISES.filter((e) => progress[e.id].solid)

  /*
   * The warm-up is always alternating hands, from day one.
   *
   * An earlier version used a single-hand exercise until alternating was "mastered", on
   * the theory that alternating is harder. That was wrong twice over: slow alternating
   * singles are the standard beginner warm-up, and more importantly it meant a whole
   * session could pass without her left hand doing anything at all.
   */
  const warmUp = EXERCISES.find((e) => e.id === 'singles') || EXERCISES[0]

  /*
   * The finisher is the hardest thing she has actually mastered — the most satisfying
   * thing she can currently play, and a free helping of spaced repetition.
   *
   * A brand new drummer has no such thing, and inventing one just repeats the focus for
   * a third time: three of four steps identical, which reads as a very boring plan. So
   * the session is simply shorter until she has earned a favourite, and gains a step
   * when she does. The plan growing with her is worth more than filling a slot.
   */
  /*
   * Only the focus is excluded. The warm-up may double as the finisher: it runs short
   * and deliberately slow at the start, and at her earned tempo at the end, which are
   * different enough to be worth doing — and it means the reward slot arrives as soon
   * as she has mastered anything at all, rather than waiting for a second thing.
   */
  const alreadyPlayed = new Set([focus.id, focus.mirror].filter(Boolean))
  const candidates = solid.filter((e) => !alreadyPlayed.has(e.id))
  const finisher = candidates.length ? candidates[candidates.length - 1] : null

  /*
   * Bars are derived from a time target, not fixed.
   *
   * Fixed bar counts made the session quietly shorter as she got faster — the same ten
   * bars take a third less time at 80 BPM than at 60 — and the first version added up to
   * 2.6 minutes of drumming while claiming five.
   *
   * The shares are also normalised over the steps that actually exist. A beginner has no
   * favourite yet, and without this her session came out a minute shorter than everyone
   * else's purely because she had one fewer slot to fill.
   */
  const warmBpm = Math.max(TEMPO.min, tempoFor(history, warmUp.id) - 10)
  const focusBpm = tempoFor(history, focus.id)
  const finBpm = finisher ? tempoFor(history, finisher.id) : null

  /*
   * The second focus slot plays the OTHER HAND where the exercise has one.
   *
   * Practising the right hand twice and the left not at all is how a weak hand stays
   * weak. Where an exercise is hand-specific its mirror takes the repeat slot, so both
   * hands are worked every single day; where it is not — alternating strokes,
   * paradiddles — the repeat is a genuine second go, which is what those need.
   */
  const mirror = focus.mirror ? EXERCISES.find((e) => e.id === focus.mirror) : null
  const second = mirror || focus
  const secondBpm = mirror ? tempoFor(history, mirror.id) : focusBpm

  const layout = [
    { kind: 'warmup', ex: warmUp, bpm: warmBpm, weight: SESSION.weights.warmup, label: 'Warm up' },
    { kind: 'focus', ex: focus, bpm: focusBpm, weight: SESSION.weights.focus, label: 'Today’s thing' },
    {
      kind: 'focus',
      ex: second,
      bpm: secondBpm,
      weight: SESSION.weights.focus,
      label: mirror ? 'Other hand' : 'Once more',
    },
  ]
  if (finisher) {
    layout.push({ kind: 'finisher', ex: finisher, bpm: finBpm, weight: SESSION.weights.finisher, label: 'Favourite' })
  }

  const totalWeight = layout.reduce((t, l) => t + l.weight, 0)
  const steps = layout.map((l) => {
    const secondsPerBar = (l.ex.beatsPerBar * 60) / l.bpm
    // Each step also carries a count-in, which is playing time she has to sit through.
    const countIn = 4 * (60 / l.bpm)
    const want = (SESSION.targetPlayingSeconds * (l.weight / totalWeight) - countIn) / secondsPerBar
    return {
      kind: l.kind,
      id: l.ex.id,
      bpm: l.bpm,
      label: l.label,
      // Capped by how long the step would last, not by how many bars that takes; see
      // SESSION.maxStepSeconds.
      bars: Math.max(SESSION.minBars, Math.min(
        SESSION.maxBars,
        Math.floor(SESSION.maxStepSeconds / secondsPerBar),
        Math.round(want),
      )),
    }
  })

  return {
    steps,
    playingSeconds: Math.round(steps.reduce((t, st) => {
      const ex = EXERCISES.find((e) => e.id === st.id)
      const perBar = (ex.beatsPerBar * 60) / st.bpm
      return t + st.bars * perBar + 4 * (60 / st.bpm)     // include the count-in
    }, 0)),
    focusId: focus.id,
    // Worth announcing: a new focus is the closest thing to unlocking something.
    newFocus: progress[focus.id].attempts === 0,
    progress,
  }
}

/** A bonus round for the days she wants to keep going. Never part of the plan. */
export function bonusStep (history, plan) {
  return {
    kind: 'bonus',
    id: plan.focusId,
    bars: 8,
    bpm: tempoFor(history, plan.focusId),
    label: 'Bonus round',
  }
}
