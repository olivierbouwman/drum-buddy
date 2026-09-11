/**
 * Automatic difficulty. The failure modes worth guarding against are oscillation
 * (level flapping every attempt) and over-eagerness (one good go promoting her into a
 * level she then fails at).
 */
import { readFileSync } from 'node:fs'
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

console.log('\nwhat belongs to the player and what belongs to the tablet')
{
  /*
   * Read from the source rather than exercising it: this storage lives in main.js behind
   * a DOM the tests do not build. What can be checked, and what actually broke, is the
   * symmetry — every key read one way and written another is a setting that silently
   * does not persist.
   */
  const src = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')

  const uses = (re) => [...src.matchAll(re)].length
  const scopedLevel = uses(/localStorage\.(?:get|set)Item\(\s*players\.key\(LEVEL_STORAGE_KEY/g)
  const unscopedLevel = uses(/localStorage\.(?:get|set)Item\(\s*LEVEL_STORAGE_KEY/g)

  check('every level access is player-scoped', unscopedLevel === 0,
    `${unscopedLevel} unscoped, ${scopedLevel} scoped`)
  check('and there are several of them to be consistent about', scopedLevel >= 4)

  /*
   * The opposite rule for the timing constants. They describe the tablet's speaker and
   * its accelerometer, not the person holding the sticks, so scoping them to a player
   * would make a guest lose the calibration and make every new profile start wrong.
   */
  for (const key of ['NUDGE_KEY', 'PAD_TRIM_KEY', 'PAD_DELAY_KEY']) {
    const scoped = uses(new RegExp(`localStorage\\.(?:get|set|remove)Item\\(\\s*players\\.key\\(${key}`, 'g'))
    const plain = uses(new RegExp(`localStorage\\.(?:get|set|remove)Item\\(\\s*${key}`, 'g'))
    check(`${key} is shared by everyone who uses the tablet`, scoped === 0 && plain > 0,
      `${scoped} scoped, ${plain} plain`)
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
