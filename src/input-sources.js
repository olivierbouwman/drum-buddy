/**
 * Input sources — everything that can register "she hit the pad".
 *
 * All of them emit the same shape: { time, strength, source }, where `time` is in
 * AudioContext seconds. Never performance.now(); see timing-model.js for why.
 *
 * TapInput exists so the whole game is playable before the mic detector is tuned, and
 * stays useful afterwards as a fallback when the mic is blocked.
 */

/** Keydown can target window or document, neither of which has closest(). */
const isButton = (t) => !!(t && typeof t.closest === 'function' && t.closest('button'))

export class InputSource {
  constructor (name) {
    this.name = name
    this.available = false
    this._listeners = []
  }

  onHit (fn) { this._listeners.push(fn); return this }

  emit (hit) {
    for (const fn of this._listeners) fn(hit)
  }

  start () {}
  stop () {}
}

/**
 * Space bar or a screen tap. Uses the event's own timestamp rather than reading the
 * clock in the handler — the event fired when she actually touched, which may be a
 * frame or two before we get to run.
 */
export class TapInput extends InputSource {
  constructor (engine, target = document.body) {
    super('tap')
    this.engine = engine
    this.target = target
    this.available = true
    this._onKey = (e) => {
      if (e.code !== 'Space' || e.repeat) return
      if (isButton(e.target)) return           // let buttons be buttons
      e.preventDefault()
      this._fire(e.timeStamp)
    }
    this._onPointer = (e) => {
      if (isButton(e.target)) return
      this._fire(e.timeStamp)
    }
  }

  _fire (perfMs) {
    // Invert the engine's context->performance mapping.
    const offset = this.engine.clockOffset
    const t = offset === null
      ? this.engine.now
      : (perfMs - offset) / 1000
    this.emit({ time: t, strength: 1, source: 'tap' })
  }

  start () {
    window.addEventListener('keydown', this._onKey)
    this.target.addEventListener('pointerdown', this._onPointer)
  }

  stop () {
    window.removeEventListener('keydown', this._onKey)
    this.target.removeEventListener('pointerdown', this._onPointer)
  }
}

/**
 * Combines the microphone and the accelerometer.
 *
 * The accelerometer leads. It is physically immune to the two hardest problems here —
 * the metronome bleeding out of the speaker, and a noisy room — and on the real tablet
 * it found 26 of 32 notes with 30 ms of spread, comfortably inside a beginner's own.
 * It needs no learned bands, no bleed rejection and no thresholds tuned per room. The
 * microphone, by contrast, has been the source of nearly every failure in this app, and
 * in one session delivered pure silence for thirty-six seconds while reporting itself
 * healthy.
 *
 * The microphone still does the one thing the accelerometer cannot: measure absolute
 * delay. A speaker can be heard coming back; a wrist cannot. So the split is that the
 * pad says WHEN SHE HIT, and the microphone says HOW LATE EVERYTHING IS.
 *
 * When both are working the constant offset between them is measured directly and used
 * to bring the accelerometer's timing onto the microphone's reference.
 */
export class FusedInput extends InputSource {
  constructor ({ mic, motion, agreeMs }) {
    super('fused')
    this.mic = mic
    this.motion = motion
    this.agreeMs = agreeMs
    this.recentMic = []
    this.recentMotion = []
    this.confirmed = 0
    this.unconfirmed = 0
    /** median(motion time - mic time) for the same strike, in seconds. */
    this.motionOffsetS = 0
    this._offsets = []
    this.motionHits = 0

    if (motion) {
      motion.onHit((hit) => {
        this.motionHits++
        const t = hit.time
        this.recentMotion.push(t)
        if (this.recentMotion.length > 40) this.recentMotion.shift()
        this._pairUp(t, 'motion')
        if (this.preferMotion) {
          this.emit({
            ...hit,
            time: t - this.motionOffsetS,
            corroborated: this._sawMic(t),
            timingTrusted: true,
            source: 'motion',
          })
        }
      })
    }

    if (mic) {
      mic.onHit((hit) => {
        const t = hit.time
        this.recentMic.push(t)
        if (this.recentMic.length > 40) this.recentMic.shift()
        this._pairUp(t, 'mic')
        if (this.preferMotion) return          // the pad already reported this strike
        const seen = this._sawMotion(t)
        if (seen) this.confirmed++
        else this.unconfirmed++
        this.emit({ ...hit, corroborated: seen, timingTrusted: true })
      })
    }

    this.available = !!((mic && mic.available) || (motion && motion.available))
  }

  _sawMotion (t) { return this.recentMotion.some((m) => Math.abs(t - m) * 1000 <= this.agreeMs) }
  _sawMic (t) { return this.recentMic.some((m) => Math.abs(t - m) * 1000 <= this.agreeMs) }

  /**
   * Learn the constant gap between the two sensors from strikes they both saw.
   *
   * The microphone's timestamps are sample-accurate and already latency-corrected, so
   * the difference is exactly what has to come off the accelerometer's. Median, because
   * a few mismatched pairs should not move it.
   */
  _pairUp (t, from) {
    const other = from === 'motion' ? this.recentMic : this.recentMotion
    let best = null
    for (const o of other) {
      const d = Math.abs(t - o) * 1000
      if (d <= this.agreeMs && (best === null || d < Math.abs(t - best) * 1000)) best = o
    }
    if (best === null) return
    const delta = from === 'motion' ? t - best : best - t
    this._offsets.push(delta)
    if (this._offsets.length > 25) this._offsets.shift()
    if (this._offsets.length >= 6) {
      const s = [...this._offsets].sort((a, b) => a - b)
      this.motionOffsetS = s[s.length >> 1]
    }
  }

  /** A granted microphone that delivers nothing is not a working microphone. */
  get micWorking () {
    return !!(this.mic && this.mic.available && this.mic.receiving)
  }

  /** The pad leads whenever it is there and actually feeling her play. */
  get preferMotion () {
    return !!(this.motion && this.motion.available)
  }

  /** Which sensor is actually deciding when a hit happened. */
  get timingSource () {
    if (this.preferMotion) return 'motion'
    if (this.micWorking) return 'mic'
    if (this.mic && this.mic.available) return 'mic-silent'
    return 'none'
  }

  /** How often the two sensors agreed — a hint that one of them is struggling. */
  get corroborationRate () {
    const n = this.confirmed + this.unconfirmed
    return n ? this.confirmed / n : null
  }

  start () {
    if (this.mic && this.mic.available) this.mic.start()
    if (this.motion && this.motion.available) this.motion.start()
  }

  stop () {
    if (this.mic) this.mic.stop()
    if (this.motion) this.motion.stop()
  }
}
