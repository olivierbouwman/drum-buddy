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
import { TimingModel } from '../src/timing-model.js'
import { ClickProbe, probeOffsetSeconds } from '../src/dsp-core.js'
import { readWav } from '../tools/wav.mjs'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'recordings')

let passed = 0
let failed = 0
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`) }
  else { failed++; console.log(`  FAIL ${name}${detail ? '  <- ' + detail : ''}`) }
}

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

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
