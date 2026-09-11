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
 * The roles are set by what the Phase 0 recordings actually showed, not by what the two
 * sensors could do in principle:
 *
 *   - The MICROPHONE is the timing source. Its onsets are stamped on the audio render
 *     thread and are sample-accurate.
 *   - The ACCELEROMETER is a fallback and a corroboration signal. On the real pad the
 *     two sensors agreed on only 15 of 37 events, and where they did agree the offset
 *     between them scattered by 38 ms.
 *
 * That measured disagreement rules out two things I had planned. It is not reliable
 * enough to TIME a hit the microphone missed, and — more tempting, and more dangerous —
 * it is not reliable enough to VETO a microphone hit it failed to feel. Vetoing would
 * have thrown away real hits every time the pad damped a strike, and it would have
 * looked like the child missing notes rather than like a bug.
 *
 * So while the microphone works, the accelerometer only corroborates. It takes over
 * completely when there is no microphone, and then the app says timing is approximate.
 */
export class FusedInput extends InputSource {
  constructor ({ mic, motion, agreeMs }) {
    super('fused')
    this.mic = mic
    this.motion = motion
    this.agreeMs = agreeMs
    this.recentMotion = []
    this.confirmed = 0
    this.unconfirmed = 0

    if (mic) {
      mic.onHit((hit) => {
        const t = hit.time
        this.recentMotion = this.recentMotion.filter((m) => (t - m) * 1000 < this.agreeMs * 3)
        const seen = this.recentMotion.some((m) => Math.abs(t - m) * 1000 <= this.agreeMs)
        if (seen) this.confirmed++
        else this.unconfirmed++
        this.emit({ ...hit, corroborated: seen, timingTrusted: true })
      })
    }

    if (motion) {
      motion.onHit((hit) => {
        this.recentMotion.push(hit.time)
        // Only a timing source when there is nothing better.
        if (!mic || !mic.available) {
          this.emit({ ...hit, corroborated: false, timingTrusted: false })
        }
      })
    }

    this.available = !!((mic && mic.available) || (motion && motion.available))
  }

  /** Which sensor is actually deciding when a hit happened. */
  get timingSource () {
    if (this.mic && this.mic.available) return 'mic'
    if (this.motion && this.motion.available) return 'motion'
    return 'none'
  }

  /** How often the pad confirmed what the microphone heard — a room-noise hint. */
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
