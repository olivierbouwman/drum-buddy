/**
 * Do the two clocks run at the same rate?
 *
 * The metronome is scheduled in AudioContext time and is exact there. The visuals and
 * every hit timestamp come from performance.now(). audio-engine.js assumes the slope
 * between the two is 1.0 "to within a few ppm" and estimates only the offset — an
 * assumption written in a comment and never checked. If it is wrong, everything derived
 * from one clock slides steadily against everything derived from the other, which is
 * what a metronome that starts right and goes wrong feels like.
 *
 * Usage: node tools/clock-drift.mjs [session.json]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'tools/diag'
const file = process.argv[2] || join(DIR, readdirSync(DIR)
  .filter((f) => f.startsWith('session-') && f.endsWith('.json'))
  .sort((a, b) => statSync(join(DIR, a)).mtimeMs - statSync(join(DIR, b)).mtimeMs).pop())

const d = JSON.parse(readFileSync(file, 'utf8'))
const rows = d.clocks || []
console.log(file)
if (rows.length < 8) {
  console.error(`\n  only ${rows.length} clock samples — needs a run on the dev server with the new build`)
  process.exit(1)
}

const t0 = rows[0][0]
const p0 = rows[0][1]
const audio = rows.map((r) => (r[0] - t0))            // seconds
const perf = rows.map((r) => (r[1] - p0) / 1000)      // seconds

// Least squares slope of system time against audio time. 1.0 means they agree.
const n = audio.length
const ma = audio.reduce((a, b) => a + b, 0) / n
const mp = perf.reduce((a, b) => a + b, 0) / n
let num = 0
let den = 0
for (let i = 0; i < n; i++) {
  num += (audio[i] - ma) * (perf[i] - mp)
  den += (audio[i] - ma) ** 2
}
const slope = num / den
const ppm = (slope - 1) * 1e6
const span = audio[n - 1]
const driftMs = (slope - 1) * span * 1000

console.log(`  ${n} samples over ${span.toFixed(1)} s`)
console.log(`  slope ${slope.toFixed(8)}  (${ppm >= 0 ? '+' : ''}${ppm.toFixed(0)} ppm)`)
console.log(`  the two clocks separate by ${driftMs >= 0 ? '+' : ''}${driftMs.toFixed(1)} ms across this run`)

const off = rows.map((r) => r[2])
const fine = rows.map((r) => r[3])
const range = (xs) => `${Math.min(...xs).toFixed(1)} .. ${Math.max(...xs).toFixed(1)} (${(Math.max(...xs) - Math.min(...xs)).toFixed(1)} ms wide)`
console.log(`  clockOffset  ${range(off)}`)
console.log(`  fineOffset   ${range(fine)}`)

/*
 * Judged in ppm and projected over a whole session, not in milliseconds over one
 * exercise. A first version flagged nothing below 15 ms across the run, which let a
 * planted 300 ppm through — 12 ms over a 40-second exercise, but 90 ms over five
 * minutes of practice, and it is the five minutes she actually plays.
 */
const SESSION_S = 300
const projected = (slope - 1) * SESSION_S * 1000
const offsetWander = Math.max(...off) - Math.min(...off)

console.log(`  over a full five-minute session that is ${projected >= 0 ? '+' : ''}${projected.toFixed(0)} ms`)
console.log()

if (Math.abs(projected) > 20) {
  console.log(`  VERDICT: the clocks drift — ${ppm.toFixed(0)} ppm, ${projected.toFixed(0)} ms across a session.`)
  console.log('  audio-engine.js assumes that slope is 1 and corrects only the offset, so')
  console.log('  anything drawn or timestamped from performance.now() slides steadily')
  console.log('  against a metronome scheduled in AudioContext time. Fit the slope.')
} else if (offsetWander > 15) {
  console.log(`  VERDICT: the rate is fine (${ppm.toFixed(0)} ppm) but clockOffset wanders by`)
  console.log(`  ${offsetWander.toFixed(0)} ms. The mapping is noisy rather than sloped — the`)
  console.log('  min-tracker is the thing to look at, not the slope.')
} else {
  console.log(`  VERDICT: clocks steady (${ppm.toFixed(0)} ppm) and the mapping is steady too.`)
  console.log('  Whatever is drifting, it is not this. Rules the clocks out.')
}
