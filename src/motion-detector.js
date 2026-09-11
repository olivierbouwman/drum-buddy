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

    // Slow-moving estimate of "nothing happening", so the threshold follows the room
    // and the way the device is propped up rather than being a fixed number.
    this.rest += (mag - this.rest) * (mag < this.rest ? 0.12 : 0.01)

    const now = this.engine.now
    const threshold = this.rest * MOTION.spikeOverRest
    // 1.0 means "just triggered", so the meter reads as a fraction of the bar.
    this._onLevel(mag / (threshold || 1))

    if (mag > threshold) {
      if (mag > this.peak) { this.peak = mag; this.peakAt = now }
      this.rising = true
    } else if (this.rising) {
      if (this.peakAt - this.lastHit > MOTION.refractoryMs / 1000) {
        this.lastHit = this.peakAt
        this.emit({
          time: this.peakAt,
          strength: this.peak / (this.rest || 1),
          source: 'motion',
          // Flagged so nothing downstream can quietly take a timestamp from here.
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
