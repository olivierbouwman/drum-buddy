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
    this.crossOffsetS = null
    this.padDelayPinned = false
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

    /*
     * Best case, and exact: a stick on the pad is heard by the microphone AND felt by
     * the accelerometer — one event, two sensors, no assumptions. Shifting the pad's
     * timestamp onto the microphone's reference and applying the microphone's own
     * measured round trip needs nothing estimated.
     *
     * Writing out the three measurements available makes it clear why this wins:
     *
     *   L       = mic round trip          = outLat + inLat
     *   D_tap   = screen tap -> pad       = padDelay
     *   D_cross = pad - mic on a real hit = padDelay - inLat
     *
     *   K_motion = outLat + padDelay = L - inLat + padDelay = L + D_cross
     *
     * The tap term cancels completely. It is also the only version free of the
     * shape mismatch between a finger on glass and a stick on rubber, which biases the
     * peak the tap method depends on.
     */
    /*
     * Unless the pad delay was set by hand, in which case nothing here outranks it.
     *
     * This branch is derived from live microphone data and it replaces motionDelayS
     * outright — so on a device where someone has already sat down and tuned the pad
     * delay against their own playing, a microphone that started working mid-session
     * would silently throw that away and change what counts as on-time partway through.
     * A calibration that moves on its own is worse than one that is slightly off, because
     * the child feels it drift and has nothing to correct against.
     */
    if (!this.padDelayPinned &&
        this.crossOffsetS !== null && this.crossOffsetS !== undefined && this.latencyS) {
      return this.latencyS + this.crossOffsetS
    }

    // Fallback for a microphone that cannot hear her: the tap gives the sensor's delay
    // honestly, and only the output half has to be estimated.
    return (this.outputLatencyS || 0) + (this.motionDelayS || 0)
  }

  /** median(pad time - mic time) for the same strike, in seconds. */
  setCrossOffset (seconds) {
    this.crossOffsetS = seconds
  }

  /**
   * @param {number} outputLatencyS how late she HEARS the beat
   * @param {number} motionDelayS   how late the accelerometer reports a strike
   */
  /**
   * Freeze the pad delay: a hand-set value, which no live derivation may override.
   * @param {boolean} pinned
   */
  pinPadDelay (pinned) { this.padDelayPinned = !!pinned }

  setMotionTiming ({ outputLatencyS, motionDelayS }) {
    if (typeof outputLatencyS === 'number') this.outputLatencyS = outputLatencyS
    if (typeof motionDelayS === 'number') this.motionDelayS = motionDelayS
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

/**
 * How far ahead of its beat the click has to be handed to the speaker.
 *
 * The Web Audio clock has TWO latencies in series and the app was only counting one.
 *
 *   baseLatency    graph -> audio subsystem
 *   outputLatency  audio subsystem -> speaker
 *
 * The spec defines them as sequential, so the real delay from scheduling a sound to
 * hearing it is their sum. The app predicted arrival using outputLatency alone and drew
 * the note crossing the line at that moment, so the sound came out baseLatency late,
 * every beat. On her tablet baseLatency is one 4096-frame buffer — 85 ms — which is why
 * playing to the click scored late while playing to the graphics scored correctly.
 *
 * Two derivations agreed with each other and BOTH were wrong. baseLatency reads about
 * 85 ms; the 496 ms round trip implies an outbound leg of 248 ms against Chrome's
 * reported 171 ms, so a 77 ms shortfall. Tuned by ear on the same tablet, the answer is
 * 125 ms — which makes the true output latency 296 ms and the microphone's input leg
 * 200 ms. The round trip was never going to land on it, because halving assumes the two
 * legs are symmetric and on this device they differ by nearly a hundred milliseconds.
 *
 * Two independent estimates agreeing is not evidence they are right. They shared an
 * assumption — that the reported figures describe the whole path — and it was the
 * assumption that was wrong.
 *
 * baseLatency is used because it is the exact missing term, it needs no microphone, and
 * it is available on the first beat of a fresh install rather than only after something
 * has been measured and stored. The round trip is the fallback for a browser that does
 * not report it.
 *
 * @param {number} baseLatencyS     ctx.baseLatency: the term that was being dropped
 * @param {number|null} roundTripS  measured speaker-to-microphone round trip, if any
 * @param {number} reportedOutputS  ctx.outputLatency
 * @param {number} fallbackS        when nothing at all is known
 * @param {number} maxS             ceiling; a reading above it is not believed
 */
export function speakerNudgeS (baseLatencyS, roundTripS, reportedOutputS, fallbackS, maxS, tunedS) {
  const clamp = (v) => Math.max(0, Math.min(v, maxS))

  /*
   * A value set by ear on the ?tune screen beats every calculation here.
   *
   * Each derivation below is an inference: the browser's reported latency is a nominal
   * figure, the round trip needs halving on an assumption of symmetry, and baseLatency
   * is the right term only if the spec's model matches what the device actually does.
   * Someone watching a light and listening for a beep is judging the thing itself, to
   * about twenty milliseconds. That wins.
   */
  if (Number.isFinite(tunedS) && tunedS !== null) return clamp(tunedS)

  if (baseLatencyS > 0 && Number.isFinite(baseLatencyS)) return clamp(baseLatencyS)

  if (roundTripS > 0 && Number.isFinite(roundTripS)) {
    const shortfall = roundTripS / 2 - (reportedOutputS || 0)
    if (Number.isFinite(shortfall)) return clamp(shortfall)
  }

  return Math.min(fallbackS, maxS)
}
