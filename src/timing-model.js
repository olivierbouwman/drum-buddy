/**
 * Owns K, the latency constant, and keeps it honest while she plays.
 *
 * THE INVARIANT: everything measured lives in AudioContext time. Onsets are stamped in
 * the worklet as (currentFrame + i) / sampleRate; the scheduler records the exact
 * context times it chose. The only arithmetic is
 *
 *     error = onsetContextTime - scheduledNoteTime - K
 *
 * performance.now() is used only for animation, and must never appear in this file.
 *
 * WHY K IS MEASURED CONTINUOUSLY, AND ONLY FROM THE CLICK
 *
 * Measured on the real device, the round trip was 353 ms during one take and 394 ms
 * ninety seconds later in the same session — each rock-steady within itself. A single
 * calibration at start-up would have been 41 ms wrong by the end of a short practice,
 * which is the entire width of the "perfect" window. She would be told she was on time
 * at the start of an exercise and late at the end of it, purely from drift.
 *
 * So K is re-measured every beat. Crucially it is measured from the METRONOME CLICK
 * coming back through the microphone — a signal the app generated itself — and never
 * from her hits.
 *
 * That distinction is the whole ballgame. Adapting K from her playing would centre her
 * errors on zero by construction: a child who consistently rushes would be told she is
 * perfect, and the app would have erased the very thing it exists to show her. Adapting
 * from the click cannot do that, because the click knows nothing about her.
 */

import { CALIBRATION } from './config.js'

/** Clicks awaiting an echo. A handful of beats is plenty at any sane tempo. */
const MAX_PENDING = 24

/** Keep a rolling window and report its median — one wild reading can't move it. */
class RollingMedian {
  constructor (size) { this.size = size; this.values = [] }
  push (v) {
    this.values.push(v)
    if (this.values.length > this.size) this.values.shift()
  }
  get count () { return this.values.length }
  get median () {
    if (!this.values.length) return null
    const s = [...this.values].sort((a, b) => a - b)
    const m = s.length >> 1
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
  }
  /** MAD, scaled to be comparable with a standard deviation. */
  get spread () {
    const med = this.median
    if (med === null || this.values.length < 3) return 0
    const dev = this.values.map((v) => Math.abs(v - med)).sort((a, b) => a - b)
    return dev[dev.length >> 1] * 1.4826
  }
}

export class TimingModel {
  /**
   * @param {number} probeOffsetS the ClickProbe's intrinsic reporting delay, measured
   *   by running it over the click waveform itself (see probeOffsetSeconds).
   */
  constructor (probeOffsetS = 0) {
    this.probeOffsetS = probeOffsetS
    this.pending = []                       // clicks scheduled but not yet heard back
    this.window = new RollingMedian(9)
    this.latencyS = null
    this.status = 'unmeasured'              // unmeasured | ok | unstable | implausible
    this.lastUpdate = 0
    this.approximate = false
    /** Separate correction for pad hits; see latencyFor(). */
    this.outputLatencyS = null
    this.motionDelayS = null
    this.motionLatencyS = null
  }

  /** The scheduler tells us when it asked for a click. */
  expectClick (contextTime) {
    this.pending.push(contextTime)
    // Bound the queue by count rather than by the newest entry's timestamp. Pruning
    // against "the click just added" assumes clicks arrive in real time, which is true
    // in the app but not when replaying a recording — and an assumption that only holds
    // in one of the two places the code runs is a bug waiting to happen.
    if (this.pending.length > MAX_PENDING) {
      this.pending.splice(0, this.pending.length - MAX_PENDING)
    }
  }

  /**
   * The worklet tells us when it heard one. Match it to the nearest scheduled click and
   * fold the delay into the rolling estimate.
   * @returns {boolean} whether the observation was used
   */
  observeClick (heardAt) {
    const t = heardAt - this.probeOffsetS
    // Anything more than a couple of seconds behind the sound we just heard was never
    // going to be matched.
    this.pending = this.pending.filter((s) => s > t - 2.5)
    let best = null
    let bestGap = Infinity
    for (const sched of this.pending) {
      const gap = t - sched
      // Only look forward: a click cannot be heard before it was scheduled.
      if (gap < 0) continue
      if (gap < bestGap) { bestGap = gap; best = sched }
    }
    if (best === null) return false

    const ms = bestGap * 1000
    if (ms < CALIBRATION.plausibleMinMs || ms > CALIBRATION.plausibleMaxMs) {
      this.status = 'implausible'
      return false
    }

    /*
     * Once the latency is known, refuse readings wildly far from it.
     *
     * At a fast tempo the gap between clicks can approach the latency itself, and then
     * a click heard now is ambiguous between the one just played and the one before —
     * which yields a small, steady, entirely wrong number that looks perfectly healthy.
     * The warm-up establishes the real value using widely spaced clicks; this keeps a
     * wrap-around from quietly replacing it, while still leaving room for the genuine
     * drift this hardware shows (measured at 41 ms within one session).
     */
    if (this.latencyS !== null && !this.approximate) {
      if (Math.abs(ms - this.latencyS * 1000) > 250) return false
    }

    this.window.push(ms)
    this.pending = this.pending.filter((s) => s !== best)
    this._recompute()
    return true
  }

  _recompute () {
    if (this.window.count < 3) return
    const med = this.window.median
    const spread = this.window.spread

    // Refuse on INSTABILITY, not on size. A large latency subtracts just as cleanly as
    // a small one; a latency that will not hold still is the thing that can't be
    // corrected for. The measured device sat at 353 ms with 0.0 ms of spread and would
    // have been wrongly locked out by a rule keyed on magnitude.
    if (spread > CALIBRATION.refuseIfSpreadAboveMs) {
      this.status = 'unstable'
      return
    }
    this.latencyS = med / 1000
    this.status = 'ok'
    this.approximate = false
    this.lastUpdate = med
  }

  /** True when we trust the number enough to show her timing at all. */
  get usable () { return this.status === 'ok' && this.latencyS !== null }

  /** Big enough to be worth mentioning, but not a reason to stop. */
  get slow () {
    return this.latencyS !== null && this.latencyS * 1000 > CALIBRATION.warnAboveMs
  }

  get spreadMs () { return this.window.spread }
  get latencyMs () { return this.latencyS === null ? null : this.latencyS * 1000 }

  /**
   * Convert a detected onset into the moment she struck, relative to what she HEARD.
   *
   * Which correction applies depends on which sensor saw the hit, and getting this
   * wrong is expensive: the microphone's round trip includes the time for sound to
   * travel INTO the device, and an accelerometer has no such path. Applying the mic's
   * number to a pad hit over-subtracted by 215 ms on the real tablet, the app decided
   * she was early, and she compensated by hitting a third of a beat late.
   *
   *   microphone: strike -> air -> mic, so subtract output + input latency (the full
   *               round trip, which is exactly what the click probe measures)
   *   pad:        strike -> accelerometer, so subtract only what delays her HEARING
   *               the beat, plus the sensor's own reporting delay
   */
  correct (onsetContextTime, source = 'mic') {
    return onsetContextTime - this.latencyFor(source)
  }

  latencyFor (source) {
    if (source !== 'motion') return this.latencyS || 0
    if (this.motionLatencyS !== null && this.motionLatencyS !== undefined) return this.motionLatencyS
    // Nothing measured yet: the output half of the round trip is the dominant term.
    const out = this.outputLatencyS || 0
    return out + (this.motionDelayS || 0)
  }

  /**
   * @param {number} outputLatencyS how late she HEARS the beat
   * @param {number} motionDelayS   how late the accelerometer reports a strike
   */
  setMotionTiming ({ outputLatencyS, motionDelayS }) {
    if (typeof outputLatencyS === 'number') this.outputLatencyS = outputLatencyS
    if (typeof motionDelayS === 'number') this.motionDelayS = motionDelayS
    this.motionLatencyS = (this.outputLatencyS || 0) + (this.motionDelayS || 0)
  }

  /**
   * No microphone, so no click can be heard coming back and K cannot be measured.
   *
   * Taps are stamped from the event itself with no acoustic round trip, so the only
   * real delay is how late she HEARS the click — the output latency, which the browser
   * will estimate for us. Marked approximate so nothing pretends this is as good as a
   * measured value.
   */
  setEstimated (seconds) {
    this.latencyS = seconds
    this.status = 'ok'
    this.approximate = true
  }

  reset () {
    this.window = new RollingMedian(9)
    this.pending = []
    this.latencyS = null
    this.status = 'unmeasured'
  }
}
