/**
 * Can the app work out a device's good detection bands on its own?
 *
 * This is what replaced the offline recording-and-analysis step. Given only the two
 * things it can always get for free — the metronome bleed during a silent count-in, and
 * her own hits — the learner must rediscover, unaided, the configuration that was
 * originally arrived at by hand.
 *
 * The candidate list here deliberately INCLUDES the bands the metronome click lives in.
 * A learner that cannot throw those away is no use.
 *
 * Skipped when tools/recordings/ is empty, since it replays real audio.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OnsetDetector, ClickProbe } from '../src/dsp-core.js'
import { AutoTune } from '../src/auto-tune.js'
import { DETECTOR } from '../src/config.js'
import { readWav } from '../tools/wav.mjs'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'recordings')
let passed = 0
let failed = 0
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`) }
  else { failed++; console.log(`  FAIL ${name}${detail ? '  <- ' + detail : ''}`) }
}

console.log('\nlearning the bands from scratch')

if (!existsSync(DIR) || !readdirSync(DIR).some((f) => f.endsWith('.wav'))) {
  console.log('  (skipped — no recordings in tools/recordings/)')
  console.log(`\n${passed} passed, ${failed} failed\n`)
  process.exit(0)
}

const find = (key, ext) => {
  const f = readdirSync(DIR).find((x) => x.includes(key) && x.endsWith(ext))
  return f ? join(DIR, f) : null
}

// 800 Hz and 1 kHz are where the click lives. The learner is not told this.
const CANDIDATES = [800, 1000, 1600, 2500, 3150, 4000, 5000, 8000]
const cfg = { ...DETECTOR, bands: CANDIDATES }
const tune = new AutoTune(CANDIDATES)

{
  const { pcm, rate } = readWav(find('bleed', '.wav'))
  const det = new OnsetDetector(rate, cfg)
  const probe = new ClickProbe(rate, {})
  for (let i = 0; i < pcm.length; i += 128) {
    const blk = pcm.subarray(i, Math.min(i + 128, pcm.length))
    det.process(blk, i)
    for (const _ of probe.process(blk, i)) { void _; tune.sampleBleed(det.snapshot()) }
  }
}
{
  const { pcm, rate } = readWav(find('hits', '.wav'))
  const det = new OnsetDetector(rate, cfg)
  for (let i = 0; i < pcm.length; i += 128) {
    for (const h of det.process(pcm.subarray(i, Math.min(i + 128, pcm.length)), i)) {
      tune.sampleHit(h.levels)
    }
  }
}

const decision = tune.decide()
check('reached a decision from real audio', !!decision)

const on = (hz) => decision.mask[CANDIDATES.indexOf(hz)] === 1
check('switches OFF 800 Hz, where the click lives', !on(800))
check('switches OFF 1 kHz, where the click lives', !on(1000))
check('keeps at least four usable bands', decision.mask.filter(Boolean).length >= 4,
  `kept ${decision.mask.filter(Boolean).length}`)

const keptMargins = tune.report.bands.filter((b) => b.on).map((b) => b.marginDb)
// A modest margin is fine: agreement across bands does the heavy lifting, so a wide
// set of decent bands beats a narrow set of pristine ones.
check('every kept band has real headroom', Math.min(...keptMargins) >= 4,
  `worst ${Math.min(...keptMargins)} dB`)

// And does the learned configuration actually behave?
const runWith = (file, mask, minLevel) => {
  const { pcm, rate } = readWav(find(file, '.wav'))
  const det = new OnsetDetector(rate, cfg)
  det.setEnabledBands(mask)
  det.setMinLevel(minLevel)
  const out = []
  for (let i = 0; i < pcm.length; i += 128) {
    out.push(...det.process(pcm.subarray(i, Math.min(i + 128, pcm.length)), i))
  }
  return { out, rate }
}

const meta = JSON.parse(readFileSync(find('bleed', '.json'), 'utf8'))
const LATENCY_S = 0.3531
const clickTimes = meta.clickContextTimes.map((t) => t - meta.recordStartContextTime + LATENCY_S)

const bleedRun = runWith('bleed', decision.mask, decision.minLevel)
const onClick = bleedRun.out.filter((o) =>
  clickTimes.some((c) => Math.abs(o.frame / bleedRun.rate - c) < 0.045))
// This candidate set is deliberately adversarial — it contains the click's own bands.
// Having thrown those away, the occasional leak through the survivors is tolerable;
// the strict zero is asserted below against the set that actually ships.
check('adversarial band set: metronome leaks rarely', onClick.length <= 2,
  `${onClick.length} of ${bleedRun.out.length} triggers landed on a click`)

const hitRun = runWith('hits', decision.mask, decision.minLevel)
check('still finds her hits', hitRun.out.length >= 14, `${hitRun.out.length} found`)

// The configuration that actually ships, learned the same way, must be clean.
{
  const prodCfg = { ...DETECTOR }
  const prodTune = new AutoTune(DETECTOR.bands)
  {
    const { pcm, rate } = readWav(find('bleed', '.wav'))
    const det = new OnsetDetector(rate, prodCfg)
    const probe = new ClickProbe(rate, {})
    for (let i = 0; i < pcm.length; i += 128) {
      const blk = pcm.subarray(i, Math.min(i + 128, pcm.length))
      det.process(blk, i)
      for (const _ of probe.process(blk, i)) { void _; prodTune.sampleBleed(det.snapshot()) }
    }
  }
  {
    const { pcm, rate } = readWav(find('hits', '.wav'))
    const det = new OnsetDetector(rate, prodCfg)
    for (let i = 0; i < pcm.length; i += 128) {
      for (const h of det.process(pcm.subarray(i, Math.min(i + 128, pcm.length)), i)) {
        prodTune.sampleHit(h.levels)
      }
    }
  }
  const pd = prodTune.decide()
  const runProd = (file) => {
    const { pcm, rate } = readWav(find(file, '.wav'))
    const det = new OnsetDetector(rate, prodCfg)
    det.setEnabledBands(pd.mask)
    det.setMinLevel(pd.minLevel)
    const out = []
    for (let i = 0; i < pcm.length; i += 128) {
      out.push(...det.process(pcm.subarray(i, Math.min(i + 128, pcm.length)), i))
    }
    return { out, rate }
  }
  const pb = runProd('bleed')
  const pOnClick = pb.out.filter((o) =>
    clickTimes.some((c) => Math.abs(o.frame / pb.rate - c) < 0.045))
  check('shipping band set: ZERO false triggers from the metronome', pOnClick.length === 0,
    `${pOnClick.length} landed on a click`)
  check('shipping band set: still finds her hits', runProd('hits').out.length >= 20,
    `${runProd('hits').out.length} found`)
}

// It must degrade rather than go deaf when nothing separates cleanly.
{
  // Bleed louder than the hits in every band: nothing separates at all.
  const t = new AutoTune([1000, 1100, 1200])
  for (let i = 0; i < 8; i++) { t.sampleBleed([1, 1, 1]); t.sampleHit([0.5, 0.5, 0.5]) }
  const d = t.decide()
  check('never disables every band, even with no separation',
    d.mask.filter(Boolean).length >= 2, `kept ${d.mask.filter(Boolean).length}`)
  check('says so instead of pretending', t.report.problem !== null, `problem=${t.report.problem}`)
}

// The gate must never climb above her own hits.
{
  const t = new AutoTune([3000, 4000])
  for (let i = 0; i < 8; i++) { t.sampleBleed([10, 10]); t.sampleHit([1, 1]) }
  const d = t.decide()
  const softestHit = 2
  check('level gate can never rise above her softest hits', d.minLevel <= softestHit * 0.75,
    `gate ${d.minLevel}`)
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
