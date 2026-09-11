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

    // The self-test's fake hit does NOT go through that ceiling. The cap exists to stop
    // speaker distortion leaking into the bands we listen to, which is the right rule
    // for the metronome and exactly the wrong one for a signal we are trying to hear:
    // capped, it reached the microphone at about the level of her quietest hits and the
    // test could not find it.
    this.testGain = ctx.createGain()
    this.testGain.gain.value = 1
    this.testGain.connect(ctx.destination)
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
   * The self-test's stand-in for a drum hit.
   *
   * Has to survive a round trip the real thing never makes: out of a small speaker,
   * across the room, and back into the microphone. The first version was 4 ms of quiet
   * broadband noise and simply did not arrive — the test heard 2 of 16 on a real tablet.
   *
   * Three changes, none of which affect WHEN it is detected:
   *   - much longer (15 ms rather than 4), so it carries real energy;
   *   - loud, and routed around the metronome's anti-distortion gain cap;
   *   - band-passed into 2-10 kHz, putting that energy where the detector listens
   *     instead of spreading it where the detector cannot hear it.
   *
   * The attack stays a sharp 0.3 ms, which is what fixes the detected onset time, so a
   * fatter burst does not move the measurement it exists to check.
   */
  _noiseBurst () {
    const rate = this.ctx.sampleRate
    const n = Math.round(rate * 0.015)
    const buf = this.ctx.createBuffer(1, n, rate)
    const d = buf.getChannelData(0)
    const attack = Math.max(1, Math.round(rate * 0.0003))

    // Two cascaded wide bandpasses around 4 kHz: broad enough to light every detection
    // band, narrow enough not to waste output on frequencies the detector ignores.
    const w0 = (2 * Math.PI * 4000) / rate
    const alpha = Math.sin(w0) / (2 * 0.8)
    const a0 = 1 + alpha
    const b0 = alpha / a0
    const b2 = -alpha / a0
    const a1 = (-2 * Math.cos(w0)) / a0
    const a2 = (1 - alpha) / a0
    const st = [{ x1: 0, x2: 0, y1: 0, y2: 0 }, { x1: 0, x2: 0, y1: 0, y2: 0 }]

    let peak = 0
    for (let i = 0; i < n; i++) {
      let v = Math.random() * 2 - 1
      for (const s of st) {
        const inp = v
        v = b0 * inp + b2 * s.x2 - a1 * s.y1 - a2 * s.y2
        s.x2 = s.x1; s.x1 = inp
        s.y2 = s.y1; s.y1 = v
      }
      const env = i < attack
        ? 0.5 * (1 - Math.cos((Math.PI * i) / attack))
        : Math.exp(-(i - attack) / (rate * 0.005))
      d[i] = v * env
      peak = Math.max(peak, Math.abs(d[i]))
    }
    // Normalise to just under full scale; the point is to be heard.
    const k = peak > 0 ? 0.92 / peak : 1
    for (let i = 0; i < n; i++) d[i] *= k
    return buf
  }

  /** Fire a click at an absolute AudioContext time. */
  playAt (kind, when) {
    const src = this.ctx.createBufferSource()
    src.buffer = this.buffers[kind]
    src.connect(kind === 'calib' ? this.testGain : this.gain)
    src.start(when)
    return src
  }

  setVolume (v) {
    this.gain.gain.value = Math.min(METRONOME.maxGain, Math.max(0, v) * METRONOME.maxGain)
  }
}
