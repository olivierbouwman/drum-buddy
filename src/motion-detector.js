/**
 * Accelerometer input source.
 *
 * MEASURED against the microphone on the real pad: it feels hits clearly (21 dB
 * spike-to-rest at 60 Hz), but its TIMESTAMPS scatter by about 38 ms — far worse than
 * the 4.8 ms its sample rate implies, because DeviceMotionEvent delivery waits on the
 * main thread. Against her ~50 ms of natural scatter that would inflate every reading.
 *
 * So this is a confirmation sensor, not a timing source. It answers "a hit happened"
 * — immune to metronome bleed and to room noise, which is exactly where the microphone
 * is weakest — while the microphone answers "at exactly this moment". It only supplies
 * timing when there is no microphone at all, and then the app says so.
 */

import { MOTION } from './config.js'
import { InputSource } from './input-sources.js'

export class MotionInput extends InputSource {
  constructor (engine) {
    super('motion')
    this.engine = engine
    this.rest = 0.3            // running estimate of the at-rest magnitude
    this.window = []           // [time, magnitude] over the last MOTION.windowS seconds
    this.peak = 0
    this.rising = false
    this.lastHit = -1e9
    this.rateHz = 0
    this._samples = 0
    this._since = 0
    this.error = null
    this._onLevel = () => {}
    this._handler = (e) => this._onMotion(e)
  }

  /** Live magnitude relative to the trigger threshold, for the on-screen meter. */
  onLevel (fn) { this._onLevel = fn }

  /** Must be called from a user gesture on iOS. */
  async init () {
    if (typeof DeviceMotionEvent === 'undefined') { this.error = 'unsupported'; return false }
    try {
      if (typeof DeviceMotionEvent.requestPermission === 'function') {
        const res = await DeviceMotionEvent.requestPermission()
        if (res !== 'granted') { this.error = 'denied'; return false }
      }
    } catch {
      this.error = 'denied'
      return false
    }

    window.addEventListener('devicemotion', this._handler)
    this._since = this.engine.now

    // Desktops fire nothing at all, so wait and see before claiming the sensor works.
    await new Promise((r) => setTimeout(r, 900))
    this.rateHz = this._samples / Math.max(0.1, this.engine.now - this._since)
    if (this.rateHz < MOTION.minRateHz) {
      window.removeEventListener('devicemotion', this._handler)
      this.error = this._samples ? 'tooSlow' : 'noData'
      return false
    }
    this.available = true
    return true
  }

  _onMotion (e) {
    this._samples++
    const a = e.acceleration && e.acceleration.x !== null
      ? e.acceleration
      : e.accelerationIncludingGravity
    if (!a) return
    const mag = Math.sqrt((a.x || 0) ** 2 + (a.y || 0) ** 2 + (a.z || 0) ** 2)
    const now = this.engine.now

    /*
     * A rolling window, judged by its median and spread.
     *
     * An exponential average collapsed on the real tablet: the sensor reports exact
     * zeros between hits, so the "resting level" decayed to 1e-136, the threshold went
     * with it and every sample counted as a strike. A median cannot be dragged to zero
     * by a run of quiet samples, and the floor stops a perfectly still device becoming
     * infinitely twitchy.
     */
    this.window.push([now, mag])
    while (this.window.length && now - this.window[0][0] > MOTION.windowS) this.window.shift()
    if (this.window.length < 20) return

    const sorted = this.window.map((w) => w[1]).sort((x, y) => x - y)
    const med = sorted[sorted.length >> 1]
    const p90 = sorted[Math.floor(sorted.length * 0.9)]
    this.rest = med
    // Tuned against a real session: 26 of her 32 notes found, 30 ms spread.
    const threshold = med + Math.max(MOTION.spikeOverSpread * (p90 - med), MOTION.minThreshold)

    this._onLevel(mag / (threshold || 1), mag)

    if (mag > threshold) {
      /*
       * Both are recorded, and they are used for different things.
       *
       * A stick on rubber is so sharp that it peaks on the very sample it crosses the
       * threshold — checked against her trace, the median gap is 0 ms — and the peak is
       * the steadier of the two (51 ms of spread against 71 ms), because a partially
       * captured rise makes the onset sample jittery at 50 Hz. So HITS use the peak.
       *
       * A soft finger tap on glass is not sharp, and peaks well after it begins. Timing
       * the screen-tap calibration by its peak measured the pad's delay 88 ms too high
       * and put exactly that much systematic error into her scoring. So CALIBRATION uses
       * the onset, which is the moment of contact for both kinds of event and therefore
       * the only fair comparison between them.
       */
      if (!this.rising) this.onsetAt = now
      if (mag > this.peak) { this.peak = mag; this.peakAt = now }
      this.rising = true
    } else if (this.rising) {
      if (this.peakAt - this.lastHit > MOTION.refractoryMs / 1000) {
        this.lastHit = this.peakAt
        this.emit({
          time: this.peakAt,
          onsetTime: this.onsetAt,
          strength: this.peak,
          source: 'motion',
          // Flagged so nothing downstream takes a timestamp from here while the
          // microphone is delivering one.
          timingTrusted: MOTION.timingTrusted,
        })
      }
      this.rising = false
      this.peak = 0
    }
  }

  stop () { /* keep listening; hits are ignored when nothing is subscribed */ }
  start () {}

  close () {
    window.removeEventListener('devicemotion', this._handler)
    this.available = false
  }
}
