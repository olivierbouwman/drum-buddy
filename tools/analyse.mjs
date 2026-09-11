#!/usr/bin/env node
/**
 * Phase 0 analysis.
 *
 * Answers the two questions the whole detection design rests on:
 *   1. Is there a frequency band where her stick attack is loud and the metronome
 *      bleeding out of the speakers is quiet?
 *   2. Does the accelerometer actually feel hits through the rubber pad?
 *
 * Everything here runs offline on the recordings, so it can afford to be thorough
 * in ways the real-time detector cannot.
 *
 * Usage: npm run analyse   (reads tools/recordings/)
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'recordings')

// 1/3-octave-ish band centres. Below ~250 Hz is useless to us (laptop speakers can't
// make it, and it's where room rumble lives); above 16 kHz there's nothing but hiss.
const BANDS = [
  250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500,
  3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000,
]

// ------------------------------------------------------------------ wav reading

function readWav (path) {
  const b = readFileSync(path)
  if (b.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a RIFF file')

  let off = 12
  let fmt = null
  let data = null
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4)
    const size = b.readUInt32LE(off + 4)
    const body = off + 8
    if (id === 'fmt ') {
      fmt = {
        format: b.readUInt16LE(body),
        channels: b.readUInt16LE(body + 2),
        rate: b.readUInt32LE(body + 4),
        bits: b.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      data = { start: body, size: Math.min(size, b.length - body) }
    }
    off = body + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('missing fmt or data chunk')

  const ch = fmt.channels
  let n, get
  if (fmt.format === 3 && fmt.bits === 32) {
    n = Math.floor(data.size / 4 / ch)
    get = (i) => b.readFloatLE(data.start + i * 4 * ch)
  } else if (fmt.format === 1 && fmt.bits === 16) {
    n = Math.floor(data.size / 2 / ch)
    get = (i) => b.readInt16LE(data.start + i * 2 * ch) / 32768
  } else {
    throw new Error(`unsupported wav: format ${fmt.format}, ${fmt.bits}-bit`)
  }

  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = get(i)
  return { pcm: out, rate: fmt.rate }
}

// ------------------------------------------------------------------ fft

/** In-place iterative radix-2 FFT. re/im are Float64Array of length 2^k. */
function fft (re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k]
        const ui = im[i + k]
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
        re[i + k] = ur + vr
        im[i + k] = ui + vi
        re[i + k + len / 2] = ur - vr
        im[i + k + len / 2] = ui - vi
        const nr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = nr
      }
    }
  }
}

/** Energy per 1/3-octave band, in dBFS, for one windowed slice. */
function bandEnergy (pcm, start, len, rate) {
  let n = 1
  while (n < len) n <<= 1
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let i = 0; i < len; i++) {
    const s = start + i
    if (s < 0 || s >= pcm.length) continue
    const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (len - 1)))
    re[i] = pcm[s] * hann
  }
  fft(re, im)

  const binHz = rate / n
  const out = []
  for (const fc of BANDS) {
    const lo = fc / Math.pow(2, 1 / 6)
    const hi = fc * Math.pow(2, 1 / 6)
    let sum = 0
    let count = 0
    for (let k = Math.max(1, Math.ceil(lo / binHz)); k <= Math.min(n / 2 - 1, Math.floor(hi / binHz)); k++) {
      sum += (re[k] * re[k] + im[k] * im[k]) / (n * n)
      count++
    }
    out.push(count ? 10 * Math.log10(sum / count + 1e-20) : -200)
  }
  return out
}

const avgSpectra = (list) => {
  if (!list.length) return BANDS.map(() => -200)
  return BANDS.map((_, i) => {
    // Average in the power domain, not dB — averaging dB understates loud events.
    const p = list.reduce((a, s) => a + Math.pow(10, s[i] / 10), 0) / list.length
    return 10 * Math.log10(p + 1e-20)
  })
}

// ------------------------------------------------------------------ onsets

/** One-pole high-pass, used only to make peak-picking robust. */
function highpass (pcm, rate, fc) {
  const rc = 1 / (2 * Math.PI * fc)
  const a = rc / (rc + 1 / rate)
  const out = new Float32Array(pcm.length)
  let prevIn = 0
  let prevOut = 0
  for (let i = 0; i < pcm.length; i++) {
    out[i] = a * (prevOut + pcm[i] - prevIn)
    prevIn = pcm[i]
    prevOut = out[i]
  }
  return out
}

/** Crude but generous offline onset picker: envelope, then peaks over a floor. */
function findOnsets (pcm, rate, { refractoryMs = 100, threshDb = 12 } = {}) {
  const hp = highpass(pcm, rate, 2000)
  const hop = 64
  const env = new Float64Array(Math.floor(hp.length / hop))
  for (let i = 0; i < env.length; i++) {
    let peak = 0
    for (let j = 0; j < hop; j++) peak = Math.max(peak, Math.abs(hp[i * hop + j]))
    env[i] = peak
  }
  const sorted = Float64Array.from(env).sort()
  const floor = sorted[Math.floor(sorted.length * 0.5)] || 1e-6
  const thresh = floor * Math.pow(10, threshDb / 20)

  const refractory = Math.round((refractoryMs / 1000) * rate / hop)
  const hits = []
  let i = 1
  while (i < env.length - 1) {
    if (env[i] > thresh && env[i] >= env[i - 1] && env[i] >= env[i + 1]) {
      // Walk back to where the envelope left the floor — closer to the true attack.
      let s = i
      while (s > 0 && env[s] > floor * 2) s--
      hits.push({ sample: s * hop, peak: env[i] })
      i += refractory
    } else i++
  }
  return { hits, floor }
}

// ------------------------------------------------------------------ reporting

const dB = (v) => (v <= -199 ? '  -inf' : v.toFixed(1).padStart(6))
const hz = (f) => (f >= 1000 ? (f / 1000) + 'k' : String(f)).padStart(5)

function table (rows, headers) {
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)))
  const line = (cells) => '  ' + cells.map((c, i) => String(c).padStart(w[i])).join('  ')
  console.log(line(headers))
  console.log('  ' + w.map((n) => '-'.repeat(n)).join('  '))
  rows.forEach((r) => console.log(line(r)))
}

function load (key) {
  if (!existsSync(DIR)) return null
  const wav = readdirSync(DIR).find((f) => f.includes(key) && f.endsWith('.wav'))
  if (!wav) return null
  const meta = readdirSync(DIR).find((f) => f.includes(key) && f.endsWith('.json'))
  return {
    ...readWav(join(DIR, wav)),
    meta: meta ? JSON.parse(readFileSync(join(DIR, meta), 'utf8')) : null,
    name: wav,
  }
}

// ------------------------------------------------------------------ main

console.log('\n=== Phase 0: drum pad measurement ===\n')

if (!existsSync(DIR)) {
  console.log(`No recordings found.\n\n  1. mkdir -p ${DIR}`)
  console.log('  2. npm run dev, open /tools/record.html, do the five takes')
  console.log('  3. move the downloaded files into that folder, run this again\n')
  process.exit(0)
}

const takes = {
  roomtone: load('roomtone'),
  bleed: load('bleed'),
  hits: load('hits'),
  both: load('both'),
  motion: load('motion'),
}

const present = Object.entries(takes).filter(([, v]) => v)
if (!present.length) {
  console.log(`Folder ${DIR} exists but has no .wav files in it.\n`)
  process.exit(0)
}
console.log('Found: ' + present.map(([k, v]) => `${k} (${v.name})`).join(', ') + '\n')

const rate = present[0][1].rate
console.log(`Sample rate: ${rate} Hz`)
if (rate < 32000) console.log('  !! Too low — no usable energy above 8 kHz. Bluetooth mic?')

// --- noise floor -----------------------------------------------------------
let floorSpec = BANDS.map(() => -200)
if (takes.roomtone) {
  const { pcm } = takes.roomtone
  const slices = []
  for (let s = 0; s + 4096 < pcm.length; s += 4096) slices.push(bandEnergy(pcm, s, 4096, rate))
  floorSpec = avgSpectra(slices)
}

// --- metronome bleed -------------------------------------------------------
let bleedSpec = BANDS.map(() => -200)
if (takes.bleed) {
  const { pcm, meta } = takes.bleed
  const slices = []
  if (meta && meta.clickContextTimes && meta.clickContextTimes.length) {
    // Locate each click by its scheduled time, plus a search for the local peak —
    // the recording starts at recordStartContextTime, and the bleed arrives late by
    // the round-trip latency we're not measuring here.
    const t0 = meta.recordStartContextTime
    for (const t of meta.clickContextTimes) {
      const nominal = Math.round((t - t0) * rate)
      let best = nominal
      let bestV = 0
      for (let s = nominal; s < nominal + rate * 0.4 && s < pcm.length; s++) {
        const v = Math.abs(pcm[s])
        if (v > bestV) { bestV = v; best = s }
      }
      if (bestV > 1e-4) slices.push(bandEnergy(pcm, best - 128, 2048, rate))
    }
  }
  if (!slices.length) {
    const { hits } = findOnsets(pcm, rate, { refractoryMs: 300, threshDb: 10 })
    for (const h of hits) slices.push(bandEnergy(pcm, h.sample, 2048, rate))
  }
  bleedSpec = avgSpectra(slices)
  console.log(`Metronome clicks located in bleed take: ${slices.length}`)
}

// --- drum hits -------------------------------------------------------------
let softSpec = BANDS.map(() => -200)
let loudSpec = BANDS.map(() => -200)
let nHits = 0
if (takes.hits) {
  const { pcm } = takes.hits
  const { hits } = findOnsets(pcm, rate)
  nHits = hits.length
  const byPeak = [...hits].sort((a, b) => a.peak - b.peak)
  const third = Math.max(1, Math.floor(byPeak.length / 3))
  const soft = byPeak.slice(0, third)
  const loud = byPeak.slice(-third)
  softSpec = avgSpectra(soft.map((h) => bandEnergy(pcm, h.sample, 1024, rate)))
  loudSpec = avgSpectra(loud.map((h) => bandEnergy(pcm, h.sample, 1024, rate)))
  console.log(`Drum hits detected: ${nHits} (${soft.length} softest / ${loud.length} loudest analysed)`)
  const dur = pcm.length / rate
  console.log(`  ~${(nHits / dur).toFixed(1)} hits/sec over ${dur.toFixed(1)}s`)
}

// --- the table that decides the design -------------------------------------
console.log('\n--- Energy per band (dBFS) ---\n')
const rows = BANDS.map((f, i) => {
  const margin = softSpec[i] - bleedSpec[i]
  const verdict = softSpec[i] < -190 ? ''
    : margin > 12 ? 'GOOD'
    : margin > 6 ? 'ok'
    : margin > 0 ? 'weak'
    : 'unusable'
  return [hz(f), dB(floorSpec[i]), dB(bleedSpec[i]), dB(softSpec[i]), dB(loudSpec[i]),
    (margin > -190 ? (margin >= 0 ? '+' : '') + margin.toFixed(1) : '—'), verdict]
})
table(rows, ['band', 'room', 'bleed', 'soft hit', 'loud hit', 'margin', ''])
console.log('\n  margin = softest hits minus metronome bleed. Positive and large is what we want.')

// --- recommendation --------------------------------------------------------
console.log('\n--- Recommendation ---\n')
const usable = BANDS.map((f, i) => ({ f, m: softSpec[i] - bleedSpec[i], s: softSpec[i] }))
  .filter((b) => b.s > -190 && b.m > 6 && b.f >= 2000)

if (!takes.hits || !takes.bleed) {
  console.log('  Need both the "hits" and "bleed" takes to judge separation.')
} else if (usable.length >= 4) {
  console.log(`  Frequency separation WORKS. Use these bands:`)
  console.log(`    ${usable.map((b) => b.f + ' Hz').join(', ')}`)
  console.log(`    (best margin ${Math.max(...usable.map((b) => b.m)).toFixed(1)} dB)`)
  console.log('  -> Mic detection is viable. Proceed with the planned filterbank.')
} else if (usable.length >= 2) {
  console.log(`  Separation is MARGINAL — only ${usable.length} usable band(s):`)
  console.log(`    ${usable.map((b) => b.f + ' Hz').join(', ')}`)
  console.log('  -> Mic may work but will be fragile. Check the accelerometer result below;')
  console.log('     if motion is good, prefer it and treat the mic as a secondary confirmation.')
} else {
  console.log('  Frequency separation FAILS — the metronome bleed covers the hits.')
  console.log('  -> Turn the volume down and re-record take 1 and 3 (speaker distortion is the')
  console.log('     usual cause), or switch to the accelerometer as the primary sensor.')
}

// --- accelerometer ---------------------------------------------------------
console.log('\n--- Accelerometer ---\n')
const motionMeta = (takes.motion && takes.motion.meta) || null
if (!motionMeta || !motionMeta.motion || !motionMeta.motion.length) {
  console.log('  No motion data. Either take 5 was recorded on a desktop, or permission')
  console.log('  was denied. Re-run take 5 on the iPad over https to test this path.')
} else {
  const m = motionMeta.motion
  const mag = m.map(([, x, y, z]) => Math.sqrt(x * x + y * y + z * z))
  const times = m.map(([t]) => t)
  const sorted = [...mag].sort((a, b) => a - b)
  const med = sorted[Math.floor(sorted.length / 2)]
  const p95 = sorted[Math.floor(sorted.length * 0.95)]
  const peak = sorted[sorted.length - 1]

  let gaps = 0
  for (let i = 1; i < times.length; i++) gaps += times[i] - times[i - 1]
  const hzRate = (times.length - 1) / (gaps || 1)

  // Count clear spikes: above median + half the way to p95, with a 100 ms refractory.
  const thresh = med + (p95 - med) * 0.5
  let spikes = 0
  let lastT = -1
  for (let i = 0; i < mag.length; i++) {
    if (mag[i] > thresh && times[i] - lastT > 0.1) { spikes++; lastT = times[i] }
  }

  console.log(`  Samples: ${m.length} over ${motionMeta.seconds}s  ->  ${hzRate.toFixed(1)} Hz`)
  console.log(`  Magnitude: median ${med.toFixed(3)}, p95 ${p95.toFixed(3)}, peak ${peak.toFixed(3)} m/s²`)
  console.log(`  Clear spikes detected: ${spikes}`)

  const snr = 20 * Math.log10((p95 + 1e-6) / (med + 1e-6))
  console.log(`  Spike-to-rest ratio: ${snr.toFixed(1)} dB`)

  const quant = (1000 / hzRate) / Math.sqrt(12)
  console.log(`  Timing noise from ${hzRate.toFixed(0)} Hz sampling: ~${quant.toFixed(1)} ms RMS`)

  console.log('')
  if (hzRate < 25) {
    console.log('  Sample rate TOO LOW to be useful. Mic only.')
  } else if (snr > 12 && spikes >= 5) {
    console.log('  Accelerometer WORKS. It feels the hits clearly through the pad.')
    console.log('  -> Use it as a primary sensor. It is immune to metronome bleed and room noise,')
    console.log(`     and ${quant.toFixed(1)} ms of quantisation noise is negligible against a`)
    console.log('     beginner’s ~50 ms natural scatter.')
  } else if (snr > 6) {
    console.log('  Accelerometer is MARGINAL — it feels something, but not cleanly.')
    console.log('  -> Try again with the device touching the pad base more directly.')
    console.log('     Usable as a confirmation signal for the mic, not on its own.')
  } else {
    console.log('  Accelerometer does NOT feel the hits (the rubber is absorbing them).')
    console.log('  -> Mic only. Drop the motion path.')
  }
}

// --- cross-check on the combined take --------------------------------------
if (takes.both) {
  const { pcm } = takes.both
  const { hits } = findOnsets(pcm, rate)
  const dur = pcm.length / rate
  const expectedClicks = takes.both.meta ? takes.both.meta.clickContextTimes.length : Math.round(dur)
  console.log('\n--- Combined take (the real conditions) ---\n')
  console.log(`  ${hits.length} onsets found over ${dur.toFixed(1)}s, with ~${expectedClicks} metronome clicks playing.`)
  console.log(`  If she played one hit per click, expect ~${expectedClicks}.`)
  console.log(`  Substantially more than that means the bleed is being counted as hits.`)
}

console.log('')
