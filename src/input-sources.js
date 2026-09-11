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
 * Merges several sources into one stream, collapsing hits that are obviously the same
 * physical strike seen twice. When the mic and the accelerometer both fire, the mic's
 * timestamp wins (finer resolution) but confidence goes up, and a mic hit the
 * accelerometer did NOT see is more likely to be metronome bleed than a real strike.
 */
export class FusedInput extends InputSource {
  constructor (sources, agreeMs) {
    super('fused')
    this.sources = sources
    this.agreeMs = agreeMs
    this.pending = []
    for (const s of sources) {
      s.onHit((hit) => this._take(hit))
      if (s.available) this.available = true
    }
  }

  _take (hit) {
    const near = this.pending.find((p) => Math.abs(p.time - hit.time) * 1000 < this.agreeMs)
    if (near) {
      near.sources.add(hit.source)
      // Prefer the mic's timestamp: the accelerometer is quantised to ~60 Hz.
      if (hit.source === 'mic') near.time = hit.time
      near.strength = Math.max(near.strength, hit.strength)
      return
    }
    const rec = { time: hit.time, strength: hit.strength, sources: new Set([hit.source]) }
    this.pending.push(rec)
    // Wait briefly for a corroborating source before releasing the hit.
    setTimeout(() => {
      this.pending = this.pending.filter((p) => p !== rec)
      this.emit({
        time: rec.time,
        strength: rec.strength,
        source: [...rec.sources].join('+'),
        confidence: rec.sources.size > 1 ? 1 : 0.6,
      })
    }, this.agreeMs)
  }

  start () { this.sources.forEach((s) => s.available && s.start()) }
  stop () { this.sources.forEach((s) => s.stop()) }
}
