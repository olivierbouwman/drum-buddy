/**
 * Pre-rendered click sounds.
 *
 * Rendered once into AudioBuffers rather than built from oscillators per beat, so every
 * click is bit-identical. That matters for two reasons: the Hann envelope can be exact
 * (a hard-edged gate splatters energy up into the band the detector listens in), and an
 * identical waveform is what makes the calibration measurement repeatable.
 */

import { METRONOME } from './config.js'

export class ClickSource {
  /** @param {AudioContext} ctx */
  constructor (ctx) {
    this.ctx = ctx
    this.buffers = {}

    // Metronome gets its own gain stage with a hard ceiling — see METRONOME.maxGain.
    this.gain = ctx.createGain()
    this.gain.gain.value = METRONOME.maxGain
    this.gain.connect(ctx.destination)
  }

  async prepare () {
    this.buffers.beat = this._tone(METRONOME.freqNormal)
    this.buffers.accent = this._tone(METRONOME.freqAccent)
    this.buffers.calib = this._noiseBurst()
  }

  /** Hann-windowed sine. Sidelobes fall as f^-3, so nothing leaks into 3-10 kHz. */
  _tone (freq) {
    const n = Math.round(this.ctx.sampleRate * (METRONOME.durationMs / 1000))
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < n; i++) {
      const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)))
      d[i] = Math.sin((2 * Math.PI * freq * i) / this.ctx.sampleRate) * hann * METRONOME.peak
    }
    return buf
  }

  /**
   * Calibration click: a short bright noise burst, deliberately shaped to look like a
   * stick hit to the detector. Matching the hit's spectrum means the detector's own
   * processing delay cancels out of the latency measurement exactly, rather than
   * approximately.
   */
  _noiseBurst () {
    const rate = this.ctx.sampleRate
    const n = Math.round(rate * 0.004)
    const buf = this.ctx.createBuffer(1, n, rate)
    const d = buf.getChannelData(0)
    const attack = Math.max(1, Math.round(rate * 0.0003))
    let hp = 0
    let prev = 0
    for (let i = 0; i < n; i++) {
      const white = Math.random() * 2 - 1
      hp = 0.85 * (hp + white - prev)   // crude high-pass, pushes energy up to 2.5 kHz+
      prev = white
      const env = i < attack
        ? 0.5 * (1 - Math.cos((Math.PI * i) / attack))
        : Math.exp(-(i - attack) / (rate * 0.003))
      d[i] = hp * env * 0.35
    }
    return buf
  }

  /** Fire a click at an absolute AudioContext time. */
  playAt (kind, when) {
    const src = this.ctx.createBufferSource()
    src.buffer = this.buffers[kind]
    src.connect(this.gain)
    src.start(when)
    return src
  }

  setVolume (v) {
    this.gain.gain.value = Math.min(METRONOME.maxGain, Math.max(0, v) * METRONOME.maxGain)
  }
}
