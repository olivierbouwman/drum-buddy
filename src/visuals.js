/**
 * The bouncing ball and the per-hit feedback.
 *
 * The ball is driven by continuous beat phase, not by beat events. That is deliberate:
 * a ball arcing down toward a pad tells her when the beat is *about* to happen, and
 * anticipation is the actual skill being trained. A flash can only be reacted to.
 */

import { WINDOWS } from './config.js'

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')

export class Visuals {
  constructor () {
    this.ball = document.getElementById('ball')
    this.padsEl = document.getElementById('pads')
    this.area = document.getElementById('ball-area')
    this.verdict = document.getElementById('verdict')
    this.lane = document.querySelector('.verdict-lane')
    this.handsEl = document.getElementById('hands')
    this.pads = []
    this._raf = null
    this._lastPad = -1
  }

  /** Build one landing pad per beat in the bar. */
  setup (beatsPerBar) {
    this.beatsPerBar = beatsPerBar
    this.padsEl.innerHTML = ''
    this.pads = []
    for (let i = 0; i < beatsPerBar; i++) {
      const p = document.createElement('div')
      p.className = 'p'
      this.padsEl.append(p)
      this.pads.push(p)
    }
    this._lastPad = -1
  }

  /**
   * @param {(ts:number)=>number} phaseFn  fractional beats since the count-in started
   * @param {()=>('R'|'L'|null)} handFn    which hand plays the next note, if any
   */
  start (phaseFn, handFn) {
    this.stop()
    const tick = (ts) => {
      this.frame(phaseFn(ts))
      if (handFn) this.showHand(handFn())
      this._raf = requestAnimationFrame(tick)
    }
    this._raf = requestAnimationFrame(tick)
  }

  stop () {
    if (this._raf) cancelAnimationFrame(this._raf)
    this._raf = null
  }

  /** @param {number} phase fractional beats since the count-in started */
  frame (phase) {
    if (!this.pads.length) return
    const n = this.pads.length
    const beat = Math.floor(phase)
    const f = phase - beat

    const from = ((beat % n) + n) % n
    const to = (from + 1) % n

    const rect = this.area.getBoundingClientRect()
    const padRects = this.pads.map((p) => p.getBoundingClientRect())
    const cx = (i) => padRects[i].left - rect.left + padRects[i].width / 2

    const bw = this.ball.offsetWidth
    // Keep the arc comfortably inside the area so the ball never leaves the screen,
    // and low enough that the rise and fall read as one gesture rather than a launch.
    const arc = Math.max(40, rect.height * 0.62)

    if (reduced.matches) {
      // No flight: the ball simply sits on the pad for the current beat.
      this.ball.style.transform = `translate(${cx(from) - bw / 2}px, ${-14}px)`
    } else {
      const x = cx(from) + (cx(to) - cx(from)) * f
      const y = 4 * arc * f * (1 - f)
      this.ball.style.transform = `translate(${x - bw / 2}px, ${-y - 14}px)`
    }

    if (beat !== this._lastPad && phase >= 0) {
      this._lastPad = beat
      this.flashPad(from)
    }
  }

  flashPad (i) {
    const p = this.pads[i]
    if (!p) return
    p.classList.add('hit')
    setTimeout(() => p.classList.remove('hit'), 110)
  }

  /**
   * Which hand plays next.
   *
   * The letter lives INSIDE the ball because that is where she is already looking —
   * the ball is the anticipation cue, and making her glance elsewhere to find the hand
   * defeats the point. A blank ball means the next landing is a rest: don't hit. The
   * row below repeats it as a larger, steadier target.
   */
  showHand (hand) {
    if (hand !== this._hand) {
      this._hand = hand
      this.ball.textContent = hand || ''
      this.ball.classList.toggle('resting', !hand)
    }
    for (const el of this.handsEl.children) {
      el.classList.toggle('next', el.dataset.hand === hand)
    }
  }

  clearHands () {
    this._hand = undefined
    this.ball.textContent = ''
    this.ball.classList.remove('resting')
    for (const el of this.handsEl.children) el.classList.remove('next')
  }

  /**
   * Show a verdict. Three redundant channels — emoji, words, and where the dot lands
   * on the lane — so nothing depends on colour.
   */
  showVerdict (errorMs) {
    const a = Math.abs(errorMs)
    let kind, text
    if (a <= WINDOWS.perfect) { kind = 'perfect'; text = '⭐ Perfect!' }
    else if (errorMs < 0) { kind = 'quick'; text = a <= WINDOWS.almost ? '🐰 A bit quick!' : '🐰 Too quick!' }
    else { kind = 'slow'; text = a <= WINDOWS.almost ? '🐢 A bit slow!' : '🐢 Too slow!' }

    this.verdict.dataset.kind = kind
    this.verdict.firstElementChild.textContent = text
    this.verdict.classList.add('show')
    clearTimeout(this._vTimer)
    this._vTimer = setTimeout(() => this.verdict.classList.remove('show'), 700)

    this.dropDot(errorMs, kind)
    return kind
  }

  missed () {
    this.verdict.dataset.kind = 'miss'
    this.verdict.firstElementChild.textContent = '…'
    this.verdict.classList.add('show')
    clearTimeout(this._vTimer)
    this._vTimer = setTimeout(() => this.verdict.classList.remove('show'), 500)
  }

  /** Dots pile up on whichever side she leans — the pattern is the lesson. */
  dropDot (errorMs, kind) {
    const span = WINDOWS.almost * 2
    const pct = 50 + Math.max(-48, Math.min(48, (errorMs / span) * 100))
    const d = document.createElement('div')
    d.className = 'dot ' + kind
    d.style.left = pct + '%'
    this.lane.append(d)
    setTimeout(() => d.remove(), 2400)
  }
}

/** Little celebration shower. Purely decorative, hidden from screen readers. */
export function confetti (host, count = 26) {
  host.innerHTML = ''
  if (reduced.matches) return
  const bits = ['⭐', '🎉', '✨', '🥁', '🎵']
  for (let i = 0; i < count; i++) {
    const el = document.createElement('i')
    el.textContent = bits[i % bits.length]
    el.style.left = Math.random() * 100 + '%'
    el.style.animationDuration = 2 + Math.random() * 2 + 's'
    el.style.animationDelay = Math.random() * 1.2 + 's'
    host.append(el)
  }
  setTimeout(() => { host.innerHTML = '' }, 5000)
}
