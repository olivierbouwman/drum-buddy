/**
 * Automatic difficulty. The failure modes worth guarding against are oscillation
 * (level flapping every attempt) and over-eagerness (one good go promoting her into a
 * level she then fails at).
 */
import { assess } from '../src/level-coach.js'
import { LEVELS } from '../src/config.js'

let passed = 0
let failed = 0
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`) }
  else { failed++; console.log(`  FAIL ${name}${detail ? '  <- ' + detail : ''}`) }
}
const rep = (v, n = 5) => Array(n).fill(v)

console.log('\nautomatic level changes')

check('holds still until there are enough attempts',
  assess(rep(20), 0, 2, LEVELS).direction === 'stay')

check('holds still with too little history',
  assess([20, 22], 0, 9, LEVELS).direction === 'stay')

check('promotes a beginner who is consistently sharp',
  assess(rep(25), 0, 6, LEVELS).direction === 'up',
  JSON.stringify(assess(rep(25), 0, 6, LEVELS)))

check('does not promote a typical beginner',
  assess(rep(70), 0, 9, LEVELS).direction === 'stay',
  JSON.stringify(assess(rep(70), 0, 9, LEVELS)))

check('one brilliant attempt is not enough to promote',
  assess([80, 75, 82, 78, 15], 0, 9, LEVELS).direction === 'stay')

check('eases back when she is consistently struggling',
  assess(rep(120), 1, 6, LEVELS).direction === 'down',
  JSON.stringify(assess(rep(120), 1, 6, LEVELS)))

check('one bad attempt is not enough to demote',
  assess([30, 28, 35, 32, 200], 1, 9, LEVELS).direction === 'stay')

check('never promotes past the top level',
  assess(rep(5), LEVELS.length - 1, 9, LEVELS).direction === 'stay')

check('never demotes below the first level',
  assess(rep(500), 0, 9, LEVELS).direction === 'stay')

// Oscillation guard: after a change, hysteresis must hold her still for a while.
{
  const justMoved = assess(rep(25), 1, 1, LEVELS)
  check('will not move again immediately after a change', justMoved.direction === 'stay')
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
