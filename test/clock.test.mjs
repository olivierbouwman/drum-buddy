/**
 * The fine clock.
 *
 * Her tablet's ctx.currentTime advances in 85.3 ms steps and stands still in between,
 * so every accelerometer hit stamped with it was snapped to an 85 ms grid — which the
 * app then reported as her spread. This asserts that reading the coarse clock densely
 * and keeping the minimum recovers real time, and that averaging would not have.
 */

import { AudioEngine } from '../src/audio-engine.js'

let passed = 0
let failed = 0
function check (name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`) }
  else { failed++; console.log(`  FAIL ${name}${detail ? '  <- ' + detail : ''}`) }
}

// A stand-in for the browser's two clocks: real time advances continuously, and
// currentTime reports only the last multiple of `stepMs` it passed.
function fakeClocks (stepMs) {
  let realMs = 0
  const g = globalThis
  g.performance = { now: () => realMs }
  const engine = Object.create(AudioEngine.prototype)
  engine.ctx = { get currentTime () { return Math.floor(realMs / stepMs) * stepMs / 1000 } }
  engine._fineOffset = null
  return { engine, advance: (ms) => { realMs += ms } }
}

console.log('\nreading a coarse clock finely')
{
  const { engine, advance } = fakeClocks(85.3)

  // Watch it for two seconds at 60 fps, as the engine does.
  for (let i = 0; i < 120; i++) { engine.sampleFineClock(); advance(1000 / 60) }

  const truth = performance.now() / 1000
  const coarse = engine.ctx.currentTime
  const fine = engine.nowFine

  check('the raw clock really is that coarse',
    Math.abs(truth - coarse) * 1000 > 20, `${((truth - coarse) * 1000).toFixed(1)} ms behind`)
  check('the fine clock lands within 20 ms of real time',
    Math.abs(truth - fine) * 1000 < 20, `${((truth - fine) * 1000).toFixed(1)} ms off`)
  check('and is better than the clock it was built from',
    Math.abs(truth - fine) < Math.abs(truth - coarse))
  check('it never runs ahead of real time',
    fine <= truth + 0.001, `${((fine - truth) * 1000).toFixed(1)} ms ahead`)
}

console.log('\nthe staircase no longer reaches the timestamps')
{
  const { engine, advance } = fakeClocks(85.3)
  for (let i = 0; i < 120; i++) { engine.sampleFineClock(); advance(1000 / 60) }

  // Stamp an event every 7 ms — prime against the step, so a grid would show up as
  // repeated values — and measure how far the stamps stray from real time.
  const errs = []
  const stamps = []
  for (let i = 0; i < 200; i++) {
    engine.sampleFineClock()
    stamps.push(engine.nowFine)
    errs.push((engine.nowFine - performance.now() / 1000) * 1000)
    advance(7)
  }
  const sorted = [...errs].sort((a, b) => a - b)
  const spread = sorted[Math.floor(0.9 * errs.length)] - sorted[Math.floor(0.1 * errs.length)]

  // Spread is what gets scored, and it is the whole reason for this: a residual
  // constant error is harmless (calibration absorbs it), a 70 ms staircase is not.
  check('spread introduced by the clock is a few ms, not seventy',
    spread < 15, `${spread.toFixed(1)} ms`)

  // Every stamp distinct, and every gap the true 7 ms: proof the 85 ms grid the raw
  // clock moves on is no longer reaching the timestamps.
  check('every stamp is distinct', new Set(stamps).size === stamps.length)
  const gaps = stamps.slice(1).map((t, i) => (t - stamps[i]) * 1000)
  // Within a few ms of the true 7, never 0 and never 85. The residual wobble is the
  // tracker correcting itself: it only learns the true offset on samples that land
  // just after a tick, so between those it creeps and then snaps back by a millisecond
  // or two. That is the price of reading a coarse clock, and it is small.
  check('consecutive stamps track the true 7 ms, not 0 or 85',
    gaps.every((g) => Math.abs(g - 7) < 4),
    `min ${Math.min(...gaps).toFixed(1)} max ${Math.max(...gaps).toFixed(1)}`)
}

console.log('\na context that restarts its clock is followed, not remembered')
{
  const { engine, advance } = fakeClocks(85.3)
  for (let i = 0; i < 120; i++) { engine.sampleFineClock(); advance(1000 / 60) }
  const before = engine._fineOffset
  // Suspend/resume: currentTime jumps backwards relative to performance.now().
  engine.ctx = { currentTime: 0 }
  engine.sampleFineClock()
  check('a big jump snaps instead of crawling', engine._fineOffset !== before &&
    Math.abs(engine._fineOffset - (performance.now() - 0)) < 1)
}

console.log('\nsound and picture come off the same clock')
{
  // The mean of the staircase is half a step high; the minimum is not. Everything the
  // player sees is positioned through clockOffset, so a biased offset moves every note
  // on screen away from the sound it belongs to.
  const stepMs = 85.3
  const { engine, advance } = fakeClocks(stepMs)
  engine.outputLatency = 0.171
  engine._timestampUsable = false
  engine.clockOffset = null

  let meanOffset = null
  for (let i = 0; i < 240; i++) {
    engine.sampleFineClock()
    engine.sampleClock()
    // What the old code did: smooth a fresh read of the coarse clock.
    const raw = performance.now() - engine.ctx.currentTime * 1000 + engine.outputLatency * 1000
    meanOffset = meanOffset === null ? raw : meanOffset + (raw - meanOffset) * 0.15
    advance(1000 / 60)
  }

  const truth = performance.now() - (performance.now() / 1000) * 1000 + engine.outputLatency * 1000
  const oldErr = meanOffset - truth
  const newErr = engine.clockOffset - truth

  check('averaging the staircase really was biased by about half a step',
    oldErr > stepMs * 0.25, `${oldErr.toFixed(1)} ms`)
  check('the offset the visuals use is now within a few ms of truth',
    Math.abs(newErr) < 8, `${newErr.toFixed(1)} ms`)
  check('and a note is no longer drawn a staircase behind its sound',
    Math.abs(newErr) < Math.abs(oldErr) / 3, `old ${oldErr.toFixed(1)} new ${newErr.toFixed(1)}`)
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
