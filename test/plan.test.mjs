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
  check('the focus is repeated', plan.steps[1].id === plan.steps[2].id)
  // A beginner has no favourite yet, and inventing one just repeats the focus a third
  // time — three of four steps identical, which reads as a very boring plan.
  check('a beginner gets three steps, not a padded four', plan.steps.length === 3,
    String(plan.steps.length))
  check('a beginner does not warm up on something harder than the focus',
    plan.steps[0].id !== 'singles', plan.steps[0].id)
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
  const plan = buildPlan(runs(first, 4, 40))
  check('a finisher appears once something is mastered',
    plan.steps.length === 4 && plan.steps[3].kind === 'finisher', String(plan.steps.length))
  check('and it is the thing she mastered', plan.steps[3].id === first, plan.steps[3].id)
  check('and she works on the next one', plan.focusId === EXERCISES[1].id)
  // Once alternating hands is solid it becomes the warm-up, as a teacher would have it.
  const later = buildPlan([...runs(first, 4, 40), ...runs('quarters-left', 4, 40), ...runs('singles', 4, 40)])
  check('warm-up becomes alternating hands once she can do it',
    later.steps[0].id === 'singles', later.steps[0].id)
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
