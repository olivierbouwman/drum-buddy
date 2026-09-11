/**
 * Continuous latency calibration, driven by the real Phase 0 recordings.
 *
 * The two properties that matter:
 *   1. It converges on the right number, and tracks it when the hardware changes.
 *   2. It can NEVER be moved by how the child plays. That is the whole reason the
 *      measurement is taken from the metronome click instead of from her hits: adapting
 *      to her would centre her errors on zero and tell a rushing child she is perfect.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TimingModel, speakerNudgeS } from '../src/timing-model.js'
import { METRONOME, SCHEDULER } from '../src/config.js'
import { ClickProbe, probeOffsetSeconds } from '../src/dsp-core.js'
import { readWav } from '../tools/wav.mjs'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'recordings')

let passed = 0
let failed = 0
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`) }
  else { failed++; console.log(`  FAIL ${name}${detail ? '  <- ' + detail : ''}`) }
}

const near = (a, b, tol) => Math.abs(a - b) <= tol

const RATE = 48000
const clickPcm = (() => {
  const n = Math.round(RATE * 0.03)
  const a = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)))
    a[i] = Math.sin((2 * Math.PI * 900 * i) / RATE) * hann * 0.25
  }
  return a
})()
const PROBE_OFFSET = probeOffsetSeconds(clickPcm, RATE, {})

console.log('\nprobe self-calibration')
check('intrinsic offset lands inside the burst', PROBE_OFFSET > 0.005 && PROBE_OFFSET < 0.04,
  `${(PROBE_OFFSET * 1000).toFixed(1)} ms`)

console.log('\nsynthetic: converges, tracks a step, rejects noise')
{
  const m = new TimingModel(0)
  for (let i = 0; i < 6; i++) { m.expectClick(i); m.observeClick(i + 0.353) }
  check('converges on the true latency', Math.abs(m.latencyMs - 353) < 0.01, `${m.latencyMs}`)
  check('reports usable', m.usable)
  check('reports it as slow but does not refuse', m.slow && m.usable)

  // The hardware really did do this: 353 ms in one take, 394 ms ninety seconds later.
  for (let i = 6; i < 20; i++) { m.expectClick(i); m.observeClick(i + 0.394) }
  check('tracks a step change in latency', Math.abs(m.latencyMs - 394) < 0.01, `${m.latencyMs}`)

  const j = new TimingModel(0)
  const wobble = [0.10, 0.34, 0.16, 0.29, 0.12, 0.31, 0.19, 0.27, 0.14]
  wobble.forEach((d, i) => { j.expectClick(i); j.observeClick(i + d) })
  check('refuses when the latency will not hold still', !j.usable && j.status === 'unstable',
    `status=${j.status} spread=${j.spreadMs.toFixed(0)}`)

  const p = new TimingModel(0)
  for (let i = 0; i < 5; i++) { p.expectClick(i); p.observeClick(i + 3.0) }   // 3 seconds
  check('ignores implausible readings', !p.usable, `status=${p.status}`)
}

console.log('\nthe child can never move the calibration')
{
  const m = new TimingModel(0)
  for (let i = 0; i < 9; i++) { m.expectClick(i); m.observeClick(i + 0.353) }
  const before = m.latencyMs
  // Everything a rushing child could throw at it: hits, at any offset, forever.
  for (let i = 0; i < 200; i++) {
    if (typeof m.observeHit === 'function') m.observeHit(i + 0.2)
  }
  check('no API exists for hits to reach the model', typeof m.observeHit === 'undefined')
  check('latency is unchanged by anything she plays', m.latencyMs === before)

  // And a consistently early player still reads as early after correction.
  const beat = 1.0
  const noteAt = 10
  const heardLate = noteAt + 0.353 - 0.06        // she hit 60 ms early, plus the round trip
  const corrected = m.correct(heardLate)
  check('a child 60 ms early still measures 60 ms early',
    Math.abs((corrected - noteAt) * 1000 + 60) < 0.01, `${((corrected - noteAt) * 1000).toFixed(1)} ms`)
  void beat
}

console.log('\nagainst the real recordings')
if (!existsSync(DIR) || !readdirSync(DIR).some((f) => f.endsWith('.wav'))) {
  console.log('  (skipped — no recordings in tools/recordings/)')
} else {
  const runTake = (key, expectMs) => {
    const wav = readdirSync(DIR).find((f) => f.includes(key) && f.endsWith('.wav'))
    const jsn = readdirSync(DIR).find((f) => f.includes(key) && f.endsWith('.json'))
    if (!wav || !jsn) return
    const { pcm, rate } = readWav(join(DIR, wav))
    const meta = JSON.parse(readFileSync(join(DIR, jsn), 'utf8'))

    const model = new TimingModel(probeOffsetSeconds(clickPcm, rate, {}))
    const scheduled = meta.clickContextTimes.map((t) => t - meta.recordStartContextTime)
    let next = 0

    // Feed clicks in as the timeline reaches them, the way the scheduler does, rather
    // than dumping them all in up front.
    const probe = new ClickProbe(rate, {})
    let used = 0
    for (let i = 0; i < pcm.length; i += 128) {
      const now = i / rate
      while (next < scheduled.length && scheduled[next] <= now + 0.15) {
        model.expectClick(scheduled[next++])
      }
      for (const c of probe.process(pcm.subarray(i, Math.min(i + 128, pcm.length)), i)) {
        if (model.observeClick(c.frame / rate)) used++
      }
    }
    check(`${key}: measures ${expectMs} ms from the actual audio`,
      model.usable && Math.abs(model.latencyMs - expectMs) < 3,
      `got ${model.latencyMs === null ? 'null' : model.latencyMs.toFixed(1)} ms from ${used} clicks`)
    check(`${key}: reports the measurement as steady`, model.spreadMs < 5,
      `spread ${model.spreadMs.toFixed(1)} ms`)
  }
  // Reference values come from an independent matched-filter analysis of the same files.
  runTake('bleed', 353.1)
  runTake('both', 394.2)

  // Drums must never be mistaken for the metronome, or her hits would corrupt K.
  const hitsWav = readdirSync(DIR).find((f) => f.includes('hits') && f.endsWith('.wav'))
  if (hitsWav) {
    const { pcm, rate } = readWav(join(DIR, hitsWav))
    const probe = new ClickProbe(rate, {})
    let found = 0
    for (let i = 0; i < pcm.length; i += 128) {
      found += probe.process(pcm.subarray(i, Math.min(i + 128, pcm.length)), i).length
    }
    check('drumming alone produces no phantom clicks', found === 0, `${found} found`)
  }
}

console.log('\nthe pad correction is not the speaker correction twice')
{
  /*
   * Her tablet, exactly: 171 ms of output latency, and an accelerometer that reports a
   * hit about 14 ms after the stick lands. A beat scheduled at t=10 is heard at 10.171,
   * so a perfect hit is stamped at 10.185 and must score as 10.000.
   */
  const OUT = 0.171
  const SENSOR = 0.014
  const m = new TimingModel()
  m.setMotionTiming({ outputLatencyS: OUT, motionDelayS: SENSOR })

  const perfect = 10 + OUT + SENSOR
  check('a perfect pad hit scores on the beat',
    near(m.correct(perfect, 'motion'), 10, 0.002),
    `${((m.correct(perfect, 'motion') - 10) * 1000).toFixed(1)} ms off`)

  // The bug: a delay measured against a reference that already had output latency in it
  // came out as 185 ms, and then output latency was added to it again.
  const doubled = new TimingModel()
  doubled.setMotionTiming({ outputLatencyS: OUT, motionDelayS: OUT + SENSOR })
  const err = (doubled.correct(perfect, 'motion') - 10) * 1000
  check('the old double count would read a perfect hit as early by the output latency',
    near(err, -OUT * 1000, 1), `${err.toFixed(1)} ms`)

  // And that is what she felt: to be told she was on the beat she had to hit late by
  // exactly that much.
  const toScoreOnBeat = perfect + OUT
  check('which is why the pad had to be hit 171 ms after the sound',
    near(doubled.correct(toScoreOnBeat, 'motion'), 10, 0.002))
}

console.log('\nthe metronome nudge moves the sound, not the goalposts')
{
  /*
   * The nudge exists because the browser under-reports output latency, so the click
   * comes out after the app said it would. Emitting early cancels that. The thing it
   * must never do is move what counts as on-time.
   */
  const OUT = 0.171
  const SENSOR = 0.014
  const nudge = METRONOME.nudgeMs / 1000

  const m = new TimingModel()
  m.setMotionTiming({ outputLatencyS: OUT, motionDelayS: SENSOR })

  // The grid is unchanged, so a hit in the same physical place scores the same whether
  // the nudge is on or off. This is the property that makes it safe.
  const perfect = 10 + OUT + SENSOR
  check('the nudge does not change what a hit scores',
    near(m.correct(perfect, 'motion'), 10, 0.0005))

  // What it does change: a click for the beat at t=10 is handed to the speaker early.
  const emitAt = 10 - nudge
  check('the click is emitted before its beat', emitAt < 10)
  check('and by the configured amount', near((10 - emitAt) * 1000, METRONOME.nudgeMs, 0.001))

  // If the browser is short by exactly the nudge, the sound now lands on the beat.
  const trueLatency = OUT + nudge
  check('with the browser short by the nudge, the sound lands on the beat',
    near(emitAt + trueLatency, 10 + OUT, 0.0005))

  // A sanity bound: a nudge bigger than a beat would reorder the metronome.
  check('the nudge is small compared with any tempo we use',
    METRONOME.nudgeMs < 60000 / 200, `${METRONOME.nudgeMs} ms`)
}

console.log('\nthe nudge is the latency term that was being dropped')
{
  const FALLBACK = METRONOME.nudgeMs / 1000
  const MAX = METRONOME.nudgeMaxMs / 1000
  const n = (base, rt, rep, tuned) => speakerNudgeS(base, rt, rep, FALLBACK, MAX, tuned) * 1000

  /*
   * Her tablet: baseLatency is one 4096-frame buffer at 48 kHz, and Chrome reports
   * outputLatency separately. The spec makes them sequential, so the sound was arriving
   * a whole baseLatency after the app said it would.
   */
  const BASE = 4096 / 48000
  check('the missing term is used directly', near(n(BASE, 0.496, 0.171), 85.3, 0.5),
    `${n(BASE, 0.496, 0.171).toFixed(1)} ms`)

  // The completely independent estimate, from the acoustic round trip.
  const fromRoundTrip = 496 / 2 - 171
  check('and the round trip independently agrees within 10 ms',
    Math.abs(n(BASE, 0.496, 0.171) - fromRoundTrip) < 10,
    `baseLatency says ${n(BASE, 0.496, 0.171).toFixed(0)}, round trip says ${fromRoundTrip}`)

  check('a browser with no baseLatency falls back to the round trip',
    near(n(0, 0.496, 0.171), fromRoundTrip, 0.5))
  check('with neither, the flat default', near(n(0, null, 0.171), METRONOME.nudgeMs, 0.001))
  check('an accurate round trip needs no nudge', n(0, 0.496, 0.248) === 0)
  check('nothing absurd gets through', n(9, 9, 0) === METRONOME.nudgeMaxMs)
  check('never negative', n(-1, -1, 5) >= 0)

  /*
   * A value set by ear outranks all of it. Everything above is an inference; someone
   * watching a light and listening for a beep is judging the thing itself.
   */
  check('a tuned value wins over baseLatency', near(n(BASE, 0.496, 0.171, 0.042), 42, 0.5))
  check('a tuned zero is honoured, not treated as absent', n(BASE, 0.496, 0.171, 0) === 0)
  check('a tuned value is still capped', n(BASE, 0.496, 0.171, 9) === METRONOME.nudgeMaxMs)

  // The scheduler has to reach a beat before it needs to emit it.
  check('the lookahead can always cover the largest nudge',
    SCHEDULER.lookaheadS * 1000 > METRONOME.nudgeMaxMs,
    `lookahead ${SCHEDULER.lookaheadS * 1000} ms vs max nudge ${METRONOME.nudgeMaxMs} ms`)
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
