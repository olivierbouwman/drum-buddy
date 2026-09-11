#!/usr/bin/env node
/**
 * Run the REAL detector (src/dsp-core.js) over the real recordings.
 *
 * The decisive test is take 1: metronome playing out loud, nobody drumming. Every
 * onset reported there is a false trigger from the speakers, and the target is zero.
 * Take 4 (room tone) must likewise be silent. Take 2 tells us whether real hits —
 * including the softest ones — are still found once the thresholds are tight enough
 * to achieve that.
 *
 * Usage: node tools/tune.mjs [--sweep]
 */
import { existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { readWav } from './wav.mjs'
import { OnsetDetector } from '../src/dsp-core.js'
import { DETECTOR } from '../src/config.js'

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'recordings')
const find = (key) => {
  if (!existsSync(DIR)) return null
  const f = readdirSync(DIR).find((x) => x.includes(key) && x.endsWith('.wav'))
  return f ? readWav(join(DIR, f)) : null
}

function run (take, cfg) {
  const det = new OnsetDetector(take.rate, cfg)
  const out = []
  const BLOCK = 128                     // same quantum the worklet will see
  for (let i = 0; i < take.pcm.length; i += BLOCK) {
    const block = take.pcm.subarray(i, Math.min(i + BLOCK, take.pcm.length))
    for (const o of det.process(block, i)) out.push(o)
  }
  return out
}

const takes = { bleed: find('bleed'), hits: find('hits'), room: find('roomtone'), both: find('both') }
if (!takes.bleed || !takes.hits) {
  console.log('Need at least the bleed and hits takes in tools/recordings/.')
  process.exit(0)
}

const secs = (t) => t.pcm.length / t.rate

// Where the clicks actually landed = scheduled + the measured round-trip latency.
let bleedClickTimes = null
try {
  const j = readdirSync(DIR).find((f) => f.includes('bleed') && f.endsWith('.json'))
  if (j) {
    const meta = JSON.parse(readFileSync(join(DIR, j), 'utf8'))
    const LATENCY_S = 0.3531   // measured; see analyse.mjs
    bleedClickTimes = meta.clickContextTimes.map((t) => t - meta.recordStartContextTime + LATENCY_S)
  }
} catch { /* fall back to counting everything as click bleed */ }

/**
 * Split the bleed take's false triggers into the ones that landed on a real metronome
 * click and the ones that didn't. Only the first group is the frequency-separation
 * problem; the rest is whatever else was happening in the room while recording, and
 * tuning the detector against it would be tuning against noise.
 */
function classifyBleed (cfg) {
  const hits = run(takes.bleed, cfg)
  if (!bleedClickTimes) return { click: hits.length, other: 0 }
  const rate = takes.bleed.rate
  let click = 0, other = 0
  for (const h of hits) {
    const t = h.frame / rate
    if (bleedClickTimes.some((c) => Math.abs(t - c) < 0.045)) click++
    else other++
  }
  return { click, other }
}

function evaluate (cfg, label) {
  const b = classifyBleed(cfg)
  const room = takes.room ? run(takes.room, cfg).length : 0
  const hits = run(takes.hits, cfg)
  const rate = takes.hits.rate
  // Weakest hits are the ones a too-tight threshold loses first.
  const strengths = hits.map((h) => h.strength).sort((a, b) => a - b)
  const dyn = strengths.length
    ? 20 * Math.log10(strengths[strengths.length - 1] / (strengths[0] || 1e-9))
    : 0
  const gaps = hits.slice(1).map((h, i) => ((h.frame - hits[i].frame) / rate) * 1000)
  console.log(
    `${label.padEnd(30)} click-bleed:${String(b.click).padStart(3)}` +
    `  room-noise:${String(b.other + room).padStart(3)}` +
    `  hits:${String(hits.length).padStart(3)}` +
    `  min gap:${gaps.length ? Math.min(...gaps).toFixed(0).padStart(4) : '   -'}ms`)
  return { click: b.click, hits: hits.length }
}

console.log('\n=== real detector vs real recordings ===\n')
console.log(`bleed take ${secs(takes.bleed).toFixed(0)}s (nobody drumming — every onset is a false trigger)`)
console.log(`hits take  ${secs(takes.hits).toFixed(0)}s (various speeds and intensities)\n`)

console.log('current config:')
evaluate(DETECTOR, `  ${DETECTOR.stages} stages, ${DETECTOR.bands.length} bands`)

console.log('\nfilter order — the finding that mattered:')
for (const stages of [1, 2, 3]) evaluate({ ...DETECTOR, stages }, `  ${stages} biquad stage(s)`)

if (process.argv.includes('--sweep')) {
  console.log('\nband sets (measured margins favour 2-10 kHz):')
  const sets = {
    'plan default':        [2500, 3500, 5000, 7000, 10000, 14000],
    'measured best 6':     [2000, 2500, 3150, 4000, 5000, 8000],
    'measured, wider':     [2000, 2500, 3150, 4000, 6300, 10000],
    'avoid 2k harmonic':   [2500, 3150, 4000, 5000, 6300, 8000],
    'low+mid heavy':       [1250, 1600, 2000, 2500, 3150, 4000],
  }
  for (const [name, bands] of Object.entries(sets)) evaluate({ ...DETECTOR, bands }, '  ' + name)

  console.log('\nthreshold over noise floor (bands = measured best 6):')
  for (const t of [3, 4, 6, 8, 12]) {
    evaluate({ ...DETECTOR, bands: [2000, 2500, 3150, 4000, 5000, 8000], triggerOverFloor: t },
      `  triggerOverFloor ${t}`)
  }

  console.log('\nband agreement required:')
  for (const need of [3, 4, 5, 6]) {
    evaluate({ ...DETECTOR, bands: [2000, 2500, 3150, 4000, 5000, 8000], bandsNeeded: need },
      `  bandsNeeded ${need}`)
  }
}
console.log('')
