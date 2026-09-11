/**
 * The daily plan, and how it moves her along.
 *
 * The failure modes worth guarding: racing ahead before something is learned, speeding
 * up before she is even, and a streak that punishes a partly-finished day.
 */
import { buildPlan, progressFor, tempoFor } from '../src/practice-plan.js'
import { EXERCISES } from '../src/exercises.js'

let passed = 0
let failed = 0
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`) }
  else { failed++; console.log(`  FAIL ${name}${detail ? '  <- ' + detail : ''}`) }
}
const runs = (id, n, spread, bpm = 60) =>
  Array.from({ length: n }, () => ({ exercise: id, spreadMs: spread, bpm, score: 500, at: Date.now() }))

console.log('\nthe shape is the same every day')
{
  const plan = buildPlan([])
  check('starts with a warm-up', plan.steps[0].kind === 'warmup')
  check('warm-up is slower than the default', plan.steps[0].bpm < 60, String(plan.steps[0].bpm))
  // Was "the focus is repeated". It should not be, where the exercise has a mirror:
  // practising the right hand twice and the left not at all is how a weak hand stays
  // weak. See the both-hands checks below.
  check('the two focus slots cover the same material',
    plan.steps[1].kind === 'focus' && plan.steps[2].kind === 'focus')
  // A beginner has no favourite yet, and inventing one just repeats the focus a third
  // time — three of four steps identical, which reads as a very boring plan.
  check('a beginner gets three steps, not a padded four', plan.steps.length === 3,
    String(plan.steps.length))
  // Was the opposite check, on the theory that alternating hands is "harder" than a
  // single hand and so should wait. Wrong twice: slow alternating singles are the
  // standard beginner warm-up, and skipping them let a whole session pass with the left
  // hand doing nothing.
  check('the warm-up works both hands, from day one', plan.steps[0].id === 'singles',
    plan.steps[0].id)
}

console.log('\nboth hands get worked every day')
{
  const plan = buildPlan([])
  const ids = plan.steps.map((s) => s.id)
  const hands = plan.steps.flatMap((s) =>
    (EXERCISES.find((e) => e.id === s.id).notes || []).map((n) => n.hand))
  check('the left hand is used', hands.includes('L'), ids.join(','))
  check('the right hand is used', hands.includes('R'), ids.join(','))
  check('a single-hand focus is paired with its mirror',
    ids.includes('quarters-right') && ids.includes('quarters-left'), ids.join(','))
  check('the warm-up alternates from day one', plan.steps[0].id === 'singles', plan.steps[0].id)
}
{
  // The finisher must not repeat a hand the session already covers.
  const r = Array.from({ length: 4 }, () => ({ exercise: 'quarters-right', spreadMs: 40, bpm: 65, at: Date.now() }))
  const plan = buildPlan(r)
  const ids = plan.steps.map((s) => s.id)
  const dupes = ids.filter((v, i) => ids.indexOf(v) !== i && v !== 'singles')
  check('no exercise appears twice in one session', dupes.length === 0, ids.join(','))
}

console.log('\nit does not race ahead')
{
  const first = EXERCISES[0].id
  check('a brand new player works on the first exercise', buildPlan([]).focusId === first)
  check('one good run is not enough to move on',
    buildPlan(runs(first, 1, 40)).focusId === first)
  check('two good runs are still not enough',
    buildPlan(runs(first, 2, 40)).focusId === first)
  check('three steady runs move her on',
    buildPlan(runs(first, 3, 40)).focusId === EXERCISES[1].id,
    buildPlan(runs(first, 3, 40)).focusId)
  check('three UNSTEADY runs do not',
    buildPlan(runs(first, 3, 140)).focusId === first)
}

console.log('\ntempo is earned, not assumed')
{
  const id = EXERCISES[0].id
  check('starts at the default', tempoFor([], id) === 60)
  check('two steady runs do not buy a step', tempoFor(runs(id, 2, 40), id) === 60)
  check('three steady runs buy 5 BPM', tempoFor(runs(id, 3, 40), id) === 65, String(tempoFor(runs(id, 3, 40), id)))
  check('struggling eases back', tempoFor(runs(id, 3, 200, 80), id) === 75,
    String(tempoFor(runs(id, 3, 200, 80), id)))
  check('middling holds steady', tempoFor(runs(id, 3, 90, 70), id) === 70)
}

console.log('\nthe finisher is something she can actually play')
{
  const first = EXERCISES[0].id
  // Mastering only the right hand adds no finisher, and that is correct: the focus
  // becomes the left hand and its mirror is the right, so the session already covers
  // both and there is nothing left over to finish on.
  const oneHand = buildPlan(runs(first, 4, 40))
  check('mastering one hand does not add a repeat as a finisher',
    oneHand.steps.length === 3, String(oneHand.steps.length))
  check('and she moves on to the other hand', oneHand.focusId === 'quarters-left',
    oneHand.focusId)

  // Once both hands and alternating are solid, the focus moves past them and a genuine
  // finisher appears.
  const on = [...runs('quarters-right', 4, 40), ...runs('quarters-left', 4, 40), ...runs('singles', 4, 40)]
  const plan = buildPlan(on)
  check('a finisher appears once the session no longer covers everything mastered',
    plan.steps.length === 4 && plan.steps[3].kind === 'finisher', String(plan.steps.length))
  check('and it is something she has mastered',
    ['quarters-right', 'quarters-left', 'singles'].includes(plan.steps[3].id), plan.steps[3].id)
  check('the warm-up is still alternating hands', plan.steps[0].id === 'singles',
    plan.steps[0].id)
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
