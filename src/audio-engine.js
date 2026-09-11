/**
 * AudioContext lifecycle, plus the one piece of clock arithmetic the visuals need.
 *
 * Everything *measured* stays in AudioContext time (see timing-model.js). This module
 * exists so the bouncing ball can be drawn in performance.now() time and still land
 * exactly when the sound comes out of the speaker.
 */

export class AudioEngine {
  constructor () {
    this.ctx = null
    this.master = null
    /** performanceTime(ms) - contextTime(ms). Smoothed; see sampleClock(). */
    this.clockOffset = null
    this.outputLatency = 0
    this._timestampUsable = false
    this._onStateChange = null
  }

  /** Must be called from inside a real user gesture (a tap or click). */
  async start () {
    if (this.ctx) {
      if (this.ctx.state !== 'running') await this.ctx.resume()
      return this.ctx
    }
    this.ctx = new AudioContext({ latencyHint: 'interactive' })
    await this.ctx.resume()

    this.master = this.ctx.createGain()
    this.master.gain.value = 1
    this.master.connect(this.ctx.destination)

    this.ctx.onstatechange = () => {
      // Safari also uses a non-standard 'interrupted' state (phone call, other app).
      if (this._onStateChange) this._onStateChange(this.ctx.state)
    }

    this._probeTimestamp()
    this.sampleClock()
    this._clockTimer = setInterval(() => this.sampleClock(), 250)
    return this.ctx
  }

  onStateChange (fn) { this._onStateChange = fn }

  get sampleRate () { return this.ctx ? this.ctx.sampleRate : 0 }
  get now () { return this.ctx ? this.ctx.currentTime : 0 }

  /**
   * Some Safari versions ship getOutputTimestamp() returning zeros, or contextTime
   * identical to currentTime. Both are useless, so check before trusting it.
   */
  _probeTimestamp () {
    try {
      const ts = this.ctx.getOutputTimestamp()
      const lag = this.ctx.currentTime - ts.contextTime
      this._timestampUsable =
        ts.performanceTime > 0 && ts.contextTime > 0 && lag >= 0 && lag < 0.5
    } catch {
      this._timestampUsable = false
    }
    this.outputLatency = this.ctx.outputLatency || (this.ctx.baseLatency || 0.01) * 2 || 0.02
  }

  /**
   * Track the offset between the two clocks with a slow one-pole filter. The slope
   * between them is 1.0 by definition (to within a few ppm), so only the offset is
   * worth estimating — fitting a slope would just add noise.
   */
  sampleClock () {
    if (!this.ctx) return
    let offset
    if (this._timestampUsable) {
      const ts = this.ctx.getOutputTimestamp()
      if (!(ts.performanceTime > 0)) { this._probeTimestamp(); return }
      offset = ts.performanceTime - ts.contextTime * 1000
    } else {
      // Naive mapping runs early by the whole output latency, so add it back in.
      offset = performance.now() - this.ctx.currentTime * 1000 + this.outputLatency * 1000
    }
    if (this.clockOffset === null || Math.abs(offset - this.clockOffset) > 20) {
      this.clockOffset = offset          // first sample, or a real jump: snap
    } else {
      this.clockOffset += (offset - this.clockOffset) * 0.15
    }
  }

  /**
   * When a sound scheduled at AudioContext time `t` will actually be heard,
   * expressed in performance.now() milliseconds.
   */
  audibleAt (t) {
    if (this.clockOffset === null) return performance.now()
    return t * 1000 + this.clockOffset
  }

  async close () {
    clearInterval(this._clockTimer)
    if (this.ctx) await this.ctx.close()
    this.ctx = null
  }
}
