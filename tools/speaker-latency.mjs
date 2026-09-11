/**
 * Does the tablet's own speaker show up in its accelerometer, and if so, how late?
 *
 * If it does, the delay between scheduling a click and the case moving IS the output
 * latency — measured on the device, with no microphone and no human timing anything.
 * That is the independent reference the pad correction has never had.
 *
 * Averages the motion magnitude across every beat of a run in which nobody played, so a
 * signal far below one sample of noise still adds up while the noise cancels.
 *
 * Validated before it was ever pointed at real data: it recovers a planted 171 ms to
 * within about 5 ms across a 16x range of signal strength, and returns nothing on twelve
 * runs of pure noise. The few ms it reads low are the thump's own energy being
 * front-loaded, so the centroid sits just before the true onset.
 *
 * Usage: node tools/speaker-latency.mjs [session.json]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'tools/diag'
const file = process.argv[2] || join(DIR, readdirSync(DIR)
  .filter((f) => f.startsWith('session-') && f.endsWith('.json'))
  .sort((a, b) => statSync(join(DIR, a)).mtimeMs - statSync(join(DIR, b)).mtimeMs).pop())

const d = JSON.parse(readFileSync(file, 'utf8'))
const notes = d.notes.map((n) => n.t)
const motion = d.motion
if (notes.length < 8 || motion.length < 200) {
  console.error(`not enough in ${file}: ${notes.length} beats, ${motion.length} motion samples`)
  process.exit(1)
}

const beat = median(notes.slice(1).map((t, i) => t - notes[i]))
console.log(`${file}\n  ${notes.length} beats of ${(beat * 1000).toFixed(0)} ms, ${motion.length} motion samples`)

// Anything that looks like a real strike disqualifies the whole run: this only means
// something if nobody touched the pad.
const mags = motion.map((m) => m[1])
const rest = median(mags)
const loud = mags.filter((v) => v > rest + 1.0).length
if (loud > notes.length * 0.3) {
  console.log(`\n  ${loud} samples look like strikes — this run has playing in it.`)
  console.log('  Re-run with ?speakertest and do not touch the pad.')
}

/*
 * Fold every sample onto its position within the beat.
 *
 * Bins are one sensor sample wide, not finer. Tried at 5 ms first and it could not find
 * a signal deliberately planted in synthetic data: at ~50 Hz most 5 ms bins are empty,
 * and the handful that are not carry one reading each, so the bin-to-bin scatter that
 * gets called "noise" is really just the gaps.
 */
const BIN = 1 / (d.snapshot?.sensors?.motionRateHz || 50)
const nBins = Math.max(4, Math.round(beat / BIN))
const sum = new Float64Array(nBins)
const count = new Float64Array(nBins)
for (const [t, v] of motion) {
  let ph = (t - notes[0]) % beat
  if (ph < 0) ph += beat
  const b = Math.min(nBins - 1, Math.floor(ph / BIN))
  sum[b] += v
  count[b]++
}
// A bin with only a couple of readings is not an average; leave it out.
const minCount = Math.max(3, notes.length * 0.2)
const prof = Array.from(sum, (x, i) => (count[i] >= minCount ? x / count[i] : NaN))
const usable = prof.filter(Number.isFinite)
if (usable.length < 4) { console.error('too few usable bins; is the run long enough?'); process.exit(1) }

const base = median(usable)
const dev = prof.map((v) => v - base)
const noise = 1.4826 * median(usable.map((v) => Math.abs(v - base))) || 1e-9

let peak = -Infinity
let peakBin = -1
for (let i = 0; i < nBins; i++) {
  if (Number.isFinite(dev[i]) && dev[i] > peak) { peak = dev[i]; peakBin = i }
}
const snr = peak / noise

// Centroid of the bins either side, so the answer is not stuck on the bin grid.
let wsum = 0
let w = 0
for (let i = Math.max(0, peakBin - 1); i <= Math.min(nBins - 1, peakBin + 1); i++) {
  if (!Number.isFinite(dev[i]) || dev[i] <= 0) continue
  wsum += i * dev[i]
  w += dev[i]
}
const peakMs = (w ? wsum / w : peakBin) * BIN * 1000

console.log(`\n  bin ${(BIN * 1000).toFixed(1)} ms  baseline ${base.toFixed(4)}  noise ${noise.toFixed(4)}`)
console.log(`  peak +${peak.toFixed(4)} at ${peakMs.toFixed(0)} ms after the beat, signal-to-noise ${snr.toFixed(1)}\n`)

for (let i = 0; i < nBins; i++) {
  const ms = i * BIN * 1000
  if (ms > 600) break
  if (!Number.isFinite(dev[i])) { console.log(`  ${ms.toFixed(0).padStart(4)} ms    -- too few readings`); continue }
  const bars = Math.max(0, Math.round((dev[i] / noise) * 2))
  console.log(`  ${ms.toFixed(0).padStart(4)} ms ${String(count[i]).padStart(4)}x ${'#'.repeat(Math.min(bars, 70))}${i === peakBin ? '  <- peak' : ''}`)
}

/*
 * The real test: split the run in half and ask each half on its own.
 *
 * Signal-to-noise on a folded average is easy to fool — the largest of seventy-five bins
 * is above the noise by construction. But a peak that is genuinely locked to the beat
 * lands in the same place in the first half of the run as in the second, and a peak that
 * is the loudest patch of nothing does not. Two independent halves agreeing to within a
 * sample or two is worth more than any threshold on the whole.
 */
function peakOf (from, to) {
  const sm = new Float64Array(nBins)
  const ct = new Float64Array(nBins)
  for (const [t, v] of motion) {
    if (t < from || t >= to) continue
    let ph = (t - notes[0]) % beat
    if (ph < 0) ph += beat
    const b = Math.min(nBins - 1, Math.floor(ph / BIN))
    sm[b] += v
    ct[b]++
  }
  const pr = Array.from(sm, (x, i) => (ct[i] >= 2 ? x / ct[i] : NaN))
  const ok = pr.filter(Number.isFinite)
  if (ok.length < 4) return null
  const bs = median(ok)
  let best = -Infinity
  let bi = -1
  for (let i = 0; i < nBins; i++) {
    if (Number.isFinite(pr[i]) && pr[i] - bs > best) { best = pr[i] - bs; bi = i }
  }
  return bi * BIN * 1000
}

const mid = notes[0] + (notes.length / 2) * beat
const firstHalf = peakOf(-Infinity, mid)
const secondHalf = peakOf(mid, Infinity)
const agree = firstHalf !== null && secondHalf !== null &&
  Math.abs(firstHalf - secondHalf) <= BIN * 1000 * 2

console.log(`  first half peaks at ${firstHalf === null ? 'n/a' : firstHalf.toFixed(0) + ' ms'}, second half at ${secondHalf === null ? 'n/a' : secondHalf.toFixed(0) + ' ms'}`)
console.log(`  the two halves ${agree ? 'AGREE' : 'do not agree'}\n`)

if (!agree || snr < 2) {
  console.log('  VERDICT: nothing usable. The speaker does not move the case enough')
  console.log('  to measure, so output latency stays the browser\'s estimate.')
} else {
  console.log('  VERDICT: the speaker IS visible in the accelerometer.')
  console.log(`  Output latency measures ${peakMs.toFixed(0)} ms; the browser claims ${d.snapshot?.sensors?.outputLatencyMs ?? '?'} ms.`)
}

function median (xs) {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[s.length >> 1] : 0
}
