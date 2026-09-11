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
    this._fineOffset = null
    this.sampleFineClock()          // seed it: sampleClock now depends on it
    this.sampleClock()
    this._clockTimer = setInterval(() => this.sampleClock(), 250)
    // Sampled every frame, not every 250 ms: catching the moment currentTime ticks over
    // is a matter of how densely it is watched, and a quarter-second timer would see
    // roughly three steps go by between looks.
    const watchFine = () => {
      if (!this.ctx) return
      this.sampleFineClock()
      this._fineRaf = requestAnimationFrame(watchFine)
    }
    watchFine()
    return this.ctx
  }

  onStateChange (fn) { this._onStateChange = fn }

  /** Told when the device changes its mind about how long the speaker takes. */
  onLatencyChange (fn) { this._onLatencyChange = fn }

  get sampleRate () { return this.ctx ? this.ctx.sampleRate : 0 }
  get now () { return this.ctx ? this.ctx.currentTime : 0 }

  /**
   * currentTime, but with a clock that actually ticks.
   *
   * On her tablet ctx.currentTime advances in steps of 85.3 ms — one 4096-frame output
   * buffer at 48 kHz — and holds perfectly still in between. Every accelerometer hit
   * was being stamped with it, so every hit was snapped to an 85 ms grid before
   * anything else happened to it. A uniform error of that width has a p90-p10 of 68 ms,
   * and the app had been reporting a "spread" of about 70 ms all along: it was measuring
   * its own clock, not her playing. No amount of better peak detection can survive
   * being timestamped by a stopped watch.
   *
   * The recovery is the standard one for reading a fine clock through a coarse one.
   * currentTime never runs FAST — it sits at the last tick until the next one — so
   * across many samples the SMALLEST observed value of (performance.now() - currentTime)
   * is the one taken just after a tick, where the staircase error is nearly zero.
   * Tracking that minimum recovers an unbiased mapping; averaging instead would lock in
   * half a step of lag.
   *
   * The minimum is allowed to creep back up slowly so that a genuine clock adjustment
   * is followed rather than remembered forever.
   */
  get nowFine () {
    if (!this.ctx) return 0
    if (this._fineOffset === null || this._fineOffset === undefined) return this.ctx.currentTime
    return (performance.now() - this._fineOffset) / 1000
  }

  /**
   * Some Safari versions ship getOutputTimestamp() returning zeros, or contextTime
   * identical to currentTime. Both are useless, so check before trusting it.
   */
  _probeTimestamp () {
    this.outputLatency = this.ctx.outputLatency || (this.ctx.baseLatency || 0.01) * 2 || 0.02
    // Kept separately rather than folded in. It is the second half of the true delay to
    // the speaker, and the click is emitted early by exactly this much so the sound
    // lands where the app already predicted — see speakerNudgeS(). Folding it into
    // outputLatency instead would move the visuals later to meet the late sound, which
    // fixes the same mismatch by making everything slower.
    this.baseLatency = this.ctx.baseLatency || 0
    try {
      const ts = this.ctx.getOutputTimestamp()
      const lag = this.ctx.currentTime - ts.contextTime
      /*
       * The whole point of getOutputTimestamp is that contextTime trails currentTime by
       * the output latency — that gap is what makes a note appear on screen when it is
       * HEARD rather than when it was rendered.
       *
       * Accepting any lag >= 0 accepted a platform reporting no gap at all, and then
       * the visuals lost the entire output latency and ran 171 ms ahead of the sound on
       * the real tablet. Playing to the screen and playing to the beat disagreed, which
       * is worse than either being wrong on its own. So the reported gap now has to be
       * consistent with the latency the same context admits to elsewhere.
       */
      this._timestampUsable =
        ts.performanceTime > 0 && ts.contextTime > 0 &&
        lag >= this.outputLatency * 0.5 && lag < 0.8
    } catch {
      this._timestampUsable = false
    }
  }

  /**
   * Track the offset between the two clocks with a slow one-pole filter. The slope
   * between them is 1.0 by definition (to within a few ppm), so only the offset is
   * worth estimating — fitting a slope would just add noise.
   */
  sampleClock () {
    if (!this.ctx) return

    /*
     * Re-read the latency. It is not a constant.
     *
     * This was taken once at startup and never looked at again. Android changes it
     * during a session — the audio path warms up, another app takes and releases focus,
     * the device drops into a low-power mode and the buffer size moves with it. Every
     * time it did, the app carried on drawing notes to cross the line at the old figure
     * while the speaker used the new one, and sound and picture pulled apart mid-run.
     * Reported as the sync drifting inside a single practice, which is exactly what an
     * unread changing input looks like.
     */
    const reported = this.ctx.outputLatency || (this.ctx.baseLatency || 0.01) * 2 || 0.02
    if (Math.abs(reported - this.outputLatency) > 0.002) {
      this.latencyMoves = (this.latencyMoves || 0) + 1
      this.latencySeen = this.latencySeen || []
      if (this.latencySeen.length < 40) this.latencySeen.push(Math.round(reported * 1000))
      this.outputLatency = reported
      if (this._onLatencyChange) this._onLatencyChange(reported)
    }
    this.baseLatency = this.ctx.baseLatency || 0

    let offset
    if (this._timestampUsable) {
      const ts = this.ctx.getOutputTimestamp()
      if (!(ts.performanceTime > 0)) { this._probeTimestamp(); return }
      offset = ts.performanceTime - ts.contextTime * 1000
    } else {
      /*
       * Built on the fine offset, not on a fresh read of currentTime.
       *
       * currentTime sits still for 85 ms at a time on her tablet, so this difference
       * sawtooths between 0 and 85, and the one-pole filter below settles on its MEAN —
       * half a step, about 42 ms, of pure bias. Everything drawn on screen goes through
       * this offset, so every note crossed the strike line 42 ms after the sound it
       * belonged to, and a player following the visuals was pushed exactly that late.
       * Measured on the tablet as a +54 ms lean the moment the pad correction was fixed.
       *
       * The fine offset is the minimum of the same quantity rather than its mean, which
       * is the unbiased one. Sound and picture now come off the same clock.
       */
      if (this._fineOffset === null || this._fineOffset === undefined) return
      offset = this._fineOffset + this.outputLatency * 1000
    }
    if (this.clockOffset === null || Math.abs(offset - this.clockOffset) > 20) {
      this.clockOffset = offset          // first sample, or a real jump: snap
    } else {
      this.clockOffset += (offset - this.clockOffset) * 0.15
    }
  }

  /**
   * The raw AudioContext time of something that happened at `perfMs` on the performance
   * timeline. Raw, not audible: no output latency removed, so it sits on the same
   * timeline as an accelerometer stamp and the two can be subtracted meaningfully.
   */
  contextTimeFor (perfMs) {
    if (!this.ctx) return 0
    if (this._fineOffset === null || this._fineOffset === undefined) return this.ctx.currentTime
    return (perfMs - this._fineOffset) / 1000
  }

  /** One reading towards the fine clock. Cheap enough to run every animation frame. */
  sampleFineClock () {
    if (!this.ctx) return
    const t = this.ctx.currentTime
    // How coarse is this clock, really? Recorded so the tablet can answer it rather
    // than be assumed about: it was assumed continuous, and it was not.
    if (t !== this._lastCoarse) {
      if (this._lastCoarseAt) {
        const step = performance.now() - this._lastCoarseAt
        this.clockStepMs = this.clockStepMs ? Math.max(this.clockStepMs * 0.9, step) : step
      }
      this._lastCoarse = t
      this._lastCoarseAt = performance.now()
    }
    const raw = performance.now() - t * 1000
    if (this._fineOffset === null || this._fineOffset === undefined) { this._fineOffset = raw; return }
    // A suspended and resumed context restarts its clock; snap rather than crawl.
    if (Math.abs(raw - this._fineOffset) > 500) { this._fineOffset = raw; return }
    // 0.05 ms per frame is about 3 ms/s: far more than any real drift between the two
    // clocks, and slow enough that it never outruns the next tick that resets it.
    this._fineOffset = Math.min(raw, this._fineOffset + 0.05)
  }

  /**
   * When a sound scheduled at AudioContext time `t` will actually be heard,
   * expressed in performance.now() milliseconds.
   */
  audibleAt (t) {
    if (this.clockOffset === null) return performance.now()
    return t * 1000 + this.clockOffset
  }

  /**
   * The AudioContext time whose sound is reaching her ears right now.
   *
   * The inverse of audibleAt(). Animation runs against this rather than currentTime, so
   * a note drawn arriving at the strike line is the note she is hearing, not the one
   * the graph is busy rendering some tens of milliseconds ahead.
   */
  audibleNow () {
    if (this.clockOffset === null) return this.now
    return (performance.now() - this.clockOffset) / 1000
  }

  /** How far ahead of the sound the visuals would be drawn, in ms. For diagnostics. */
  get visualLagMs () {
    if (this.clockOffset === null) return null
    return Math.round(this.clockOffset - (performance.now() - this.ctx.currentTime * 1000))
  }

  async close () {
    clearInterval(this._clockTimer)
    if (this._fineRaf) cancelAnimationFrame(this._fineRaf)
    if (this.ctx) await this.ctx.close()
    this.ctx = null
  }
}
