#!/usr/bin/env node
// Writes synthetic Phase 0 takes into tools/recordings/ so the analyser and the
// detector can be regression-tested without a real drum pad. The fake hits are
// broadband transients; the fake bleed is a 900 Hz click with deliberate 3rd/5th
// harmonic distortion, which is what a small speaker really does.
//
// Usage: node tools/make-fake-recordings.mjs   (then: npm run analyse)

// Synthetic Phase 0 recordings, to prove the analyser works end to end.
import { writeFileSync, mkdirSync } from 'node:fs'
const RATE = 48000, DIR = 'tools/recordings'
mkdirSync(DIR, { recursive: true })

function wav (pcm, rate) {
  const b = Buffer.alloc(44 + pcm.length * 4)
  b.write('RIFF', 0); b.writeUInt32LE(36 + pcm.length * 4, 4); b.write('WAVE', 8)
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(32, 34)
  b.write('data', 36); b.writeUInt32LE(pcm.length * 4, 40)
  for (let i = 0; i < pcm.length; i++) b.writeFloatLE(pcm[i], 44 + i * 4)
  return b
}
const noise = (n, amp) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = (Math.random() * 2 - 1) * amp; return a }

// 900 Hz Hann click, plus a little 3rd/5th harmonic to mimic speaker distortion
function addClick (buf, at, amp) {
  const n = Math.round(RATE * 0.03)
  for (let i = 0; i < n && at + i < buf.length; i++) {
    const h = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)))
    const t = i / RATE
    buf[at + i] += (Math.sin(2 * Math.PI * 900 * t) + 0.06 * Math.sin(2 * Math.PI * 2700 * t)
                 + 0.02 * Math.sin(2 * Math.PI * 4500 * t)) * h * amp
  }
}
// Stick on rubber: broadband click, fast attack, fast decay, bright
function addHit (buf, at, amp) {
  const n = Math.round(RATE * 0.05)
  for (let i = 0; i < n && at + i < buf.length; i++) {
    const t = i / RATE
    const env = Math.exp(-t * 260) * (1 - Math.exp(-t * 40000))
    buf[at + i] += (Math.random() * 2 - 1) * env * amp
  }
}

const secs = (s) => Math.round(RATE * s)

// take 4: room tone
writeFileSync(`${DIR}/take4-roomtone.wav`, wav(noise(secs(5), 0.0006), RATE))

// take 1: metronome bleed only
{
  const buf = noise(secs(10), 0.0006)
  const clicks = []
  for (let t = 0.35; t < 10; t += 1) { addClick(buf, secs(t + 0.04), 0.09); clicks.push(+(100 + t).toFixed(5)) }
  writeFileSync(`${DIR}/take1-bleed.wav`, wav(buf, RATE))
  writeFileSync(`${DIR}/take1-bleed.json`, JSON.stringify({
    take: 1, key: 'bleed', sampleRate: RATE, seconds: 10, recordStartContextTime: 100,
    bpm: 60, clickContextTimes: clicks, motion: [] }, null, 2))
}

// take 2: hits only, mixed dynamics
{
  const buf = noise(secs(15), 0.0006)
  for (let t = 0.5, k = 0; t < 15; t += 1, k++) addHit(buf, secs(t), k % 3 === 0 ? 0.012 : k % 3 === 1 ? 0.05 : 0.15)
  writeFileSync(`${DIR}/take2-hits.wav`, wav(buf, RATE))
  writeFileSync(`${DIR}/take2-hits.json`, JSON.stringify({
    take: 2, key: 'hits', sampleRate: RATE, seconds: 15, motion: [] }, null, 2))
}

// take 3: both
{
  const buf = noise(secs(15), 0.0006)
  const clicks = []
  for (let t = 0.35; t < 15; t += 1) { addClick(buf, secs(t + 0.04), 0.09); clicks.push(+(200 + t).toFixed(5)) }
  for (let t = 0.37; t < 15; t += 1) addHit(buf, secs(t), 0.06)
  writeFileSync(`${DIR}/take3-both.wav`, wav(buf, RATE))
  writeFileSync(`${DIR}/take3-both.json`, JSON.stringify({
    take: 3, key: 'both', sampleRate: RATE, seconds: 15, recordStartContextTime: 200,
    bpm: 60, clickContextTimes: clicks, motion: [] }, null, 2))
}

// take 5: hits + motion at 60 Hz with spikes on each hit
{
  const buf = noise(secs(15), 0.0006)
  const motion = []
  const hitTimes = []
  for (let t = 0.5; t < 15; t += 1) { addHit(buf, secs(t), 0.07); hitTimes.push(t) }
  for (let i = 0; i < 15 * 60; i++) {
    const t = i / 60
    let a = 0.05 + Math.random() * 0.03
    for (const h of hitTimes) if (Math.abs(t - h) < 0.03) a += 2.2 * Math.exp(-Math.abs(t - h) * 90)
    motion.push([+(300 + t).toFixed(5), +(a * 0.4).toFixed(3), +(a * 0.3).toFixed(3), +(a * 0.86).toFixed(3)])
  }
  writeFileSync(`${DIR}/take5-motion.wav`, wav(buf, RATE))
  writeFileSync(`${DIR}/take5-motion.json`, JSON.stringify({
    take: 5, key: 'motion', sampleRate: RATE, seconds: 15, recordStartContextTime: 300,
    motion, motionRateHz: 60 }, null, 2))
}
console.log('synthetic takes written')
