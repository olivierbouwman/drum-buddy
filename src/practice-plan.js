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
import { TEMPO } from './config.js'

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

  // The finisher is the hardest thing she HAS made solid — the most satisfying thing she
  // can currently play. Before anything is solid, the very first exercise serves.
  const solid = EXERCISES.filter((e) => progress[e.id].solid)
  const finisher = solid.length ? solid[solid.length - 1] : EXERCISES[0]

  // Warm-up never changes. Alternating hands, slow, every single day.
  const warmUp = EXERCISES.find((e) => e.id === 'singles') || EXERCISES[0]

  const steps = [
    {
      kind: 'warmup',
      id: warmUp.id,
      bars: 6,
      bpm: Math.max(TEMPO.min, TEMPO.default - 10),
      label: 'Warm up',
    },
    {
      kind: 'focus',
      id: focus.id,
      bars: 10,
      bpm: tempoFor(history, focus.id),
      label: 'Today’s thing',
    },
    {
      kind: 'focus',
      id: focus.id,
      bars: 10,
      bpm: tempoFor(history, focus.id),
      label: 'Once more',
    },
    {
      kind: 'finisher',
      id: finisher.id,
      bars: 8,
      bpm: tempoFor(history, finisher.id),
      label: 'Favourite',
    },
  ]

  return {
    steps,
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
