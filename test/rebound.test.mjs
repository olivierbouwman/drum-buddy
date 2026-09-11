/**
 * The rebound rule, tested against the event that prompted it.
 *
 * One strike on her pad produced two detections 167 ms apart, the second at 22% of the
 * first's strength, and it checked off two of the four warm-up dots. The numbers here
 * are that log, not invented ones.
 */

import { MOTION } from '../src/config.js'

let passed = 0
let failed = 0
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`) }
  else { failed++; console.log(`  FAIL ${name}${detail ? '  <- ' + detail : ''}`) }
}

// The exact decision the detector makes on the falling edge.
const accepts = (gapMs, peak, lastPeak) => {
  const since = gapMs / 1000
  const rebound = since < MOTION.reboundMs / 1000 && peak < lastPeak * MOTION.reboundRatio
  return since > MOTION.refractoryMs / 1000 && !rebound
}

console.log('\nthe rebound rule')
{
  // From the log: [2.393, 2.82] then [2.560, 0.63].
  check('her doubled strike is rejected', !accepts(167, 0.63, 2.82))
  check('the refractory alone would have let it through', 167 > MOTION.refractoryMs,
    `refractory is ${MOTION.refractoryMs} ms, the rebound arrived at 167 ms`)

  // The two genuine hits either side of it, same log.
  check('a real hit 1078 ms later is kept', accepts(1078, 5.59, 0.63))
  check('a real hit 1298 ms later is kept', accepts(1298, 2.77, 5.59))
}

console.log('\nit does not eat real playing')
{
  check('eighth notes at 90 bpm survive', accepts(333, 2.0, 2.4))
  check('sixteenths at 60 bpm survive', accepts(250, 2.0, 2.4))
  check('an evenly played fast roll survives', accepts(200, 2.2, 2.0))
  // Only the combination is rejected: close AND much weaker.
  check('close but equally strong is kept', accepts(150, 2.4, 2.4))
  check('weak but far apart is kept', accepts(900, 0.5, 5.0))
  check('still inside the refractory is rejected', !accepts(80, 3.0, 3.0))
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
