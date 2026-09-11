/**
 * The audio worklet: onset detection and click probing on the render thread.
 *
 * It runs the very same OnsetDetector and ClickProbe that were tuned against the Phase 0
 * recordings — bundled in by tools/build-worklet.mjs rather than copied, so the two can
 * never drift apart.
 *
 * Timestamps are computed here as (currentFrame + i) / sampleRate, which is already in
 * AudioContext time. They travel inside the message. The classic bug is stamping a hit
 * when the main thread happens to receive the message; that would add tens of
 * milliseconds of random jitter and is exactly what this avoids.
 */
import { OnsetDetector, ClickProbe } from '../dsp-core.js'

class DrumOnsetProcessor extends AudioWorkletProcessor {
  constructor (options) {
    super()
    const o = options.processorOptions || {}
    this.det = new OnsetDetector(sampleRate, o.detector)
    this.probe = new ClickProbe(sampleRate, o.click || {})
    this.listening = true
    this.probing = true

    /*
     * A rolling window of raw audio, so a real practice session can be pulled off the
     * device and replayed through the detector offline. Tuning against a recording made
     * once, in a quiet room, on purpose, is not the same as tuning against the room she
     * actually plays in.
     */
    this.recSeconds = o.recordSeconds || 0
    if (this.recSeconds > 0) {
      this.rec = new Float32Array(Math.round(sampleRate * this.recSeconds))
      this.recPos = 0
      this.recWrapped = false
    }

    this.meterPeak = 0
    this.meterCount = 0
    this.meterEvery = Math.round(sampleRate / 20)   // 20 updates a second

    this.port.onmessage = (e) => {
      const m = e.data
      if (m.type === 'refractory') this.det.setRefractoryMs(m.ms)
      else if (m.type === 'listen') this.listening = m.on
      else if (m.type === 'probe') this.probing = m.on
      else if (m.type === 'dump') {
        this._dump()
      } else if (m.type === 'tune') {
        // The app has learned which bands separate her drum from the bleed on this
        // device. Applied live; it changes only WHETHER a hit is seen, not when.
        if (m.mask) this.det.setEnabledBands(m.mask)
        if (typeof m.minLevel === 'number') this.det.setMinLevel(m.minLevel)
      }
    }
    this.port.postMessage({ type: 'ready', sampleRate })
  }

  /** Hand the recorded window to the main thread, oldest sample first. */
  _dump () {
    if (!this.rec) return this.port.postMessage({ type: 'audio', empty: true })
    const n = this.recWrapped ? this.rec.length : this.recPos
    const out = new Float32Array(n)
    if (this.recWrapped) {
      const tail = this.rec.length - this.recPos
      out.set(this.rec.subarray(this.recPos), 0)
      out.set(this.rec.subarray(0, this.recPos), tail)
    } else {
      out.set(this.rec.subarray(0, n))
    }
    // The frame the FIRST returned sample was captured at, so it can be lined up
    // against the beat grid later.
    const startFrame = currentFrame - n
    this.port.postMessage({ type: 'audio', startFrame, sampleRate, pcm: out }, [out.buffer])
  }

  process (inputs) {
    const input = inputs[0]
    // inputs[0] can be an empty array before the source produces anything.
    if (!input || input.length === 0) return true
    const ch = input[0]
    if (!ch) return true

    if (this.listening) {
      const hits = this.det.process(ch, currentFrame)
      for (const h of hits) {
        this.port.postMessage({
          type: 'hit',
          time: h.frame / sampleRate,
          strength: h.strength,
          bands: h.bands,
          levels: h.levels,
        })
      }
    }

    if (this.probing) {
      const clicks = this.probe.process(ch, currentFrame)
      for (const c of clicks) {
        // Snapshot the filterbank at the click's arrival: this is the bleed spectrum,
        // measured on the real device instead of guessed at offline.
        this.port.postMessage({
          type: 'click',
          time: c.frame / sampleRate,
          level: c.level,
          levels: this.det.snapshot(),
        })
      }
    }

    if (this.rec) {
      for (let i = 0; i < ch.length; i++) {
        this.rec[this.recPos] = ch[i]
        if (++this.recPos >= this.rec.length) { this.recPos = 0; this.recWrapped = true }
      }
    }

    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i])
      if (a > this.meterPeak) this.meterPeak = a
    }
    this.meterCount += ch.length
    if (this.meterCount >= this.meterEvery) {
      // Band levels ride along with the meter. Sampled by the app during the gaps
      // between count-in clicks, this measures the ROOM — the floor everything else
      // has to stand above.
      this.port.postMessage({
        type: 'level',
        peak: this.meterPeak,
        levels: this.det.snapshot(),
      })
      /*
     * A rolling window of raw audio, so a real practice session can be pulled off the
     * device and replayed through the detector offline. Tuning against a recording made
     * once, in a quiet room, on purpose, is not the same as tuning against the room she
     * actually plays in.
     */
    this.recSeconds = o.recordSeconds || 0
    if (this.recSeconds > 0) {
      this.rec = new Float32Array(Math.round(sampleRate * this.recSeconds))
      this.recPos = 0
      this.recWrapped = false
    }

    this.meterPeak = 0
      this.meterCount = 0
    }

    return true
  }
}

registerProcessor('drum-onset', DrumOnsetProcessor)
