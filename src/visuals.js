/**
 * The bouncing ball and the per-hit feedback.
 *
 * The ball is driven by continuous beat phase, not by beat events. That is deliberate:
 * a ball arcing down toward a pad tells her when the beat is *about* to happen, and
 * anticipation is the actual skill being trained. A flash can only be reacted to.
 */

import { WINDOWS } from './config.js'

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')

/** How many beats fit across the screen, and where the ball sits along it. */
const VISIBLE_BEATS = 5
const BALL_X = 0.34

export class Visuals {
  constructor (countIn = 4) {
    this.countIn = countIn
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

  /**
   * Build the beat strip.
   *
   * The strip scrolls leftward under a ball that bounces in one place, rather than the
   * ball flying back across the screen at the end of each bar. The jump back read as a
   * glitch and broke the sense of time moving steadily forward.
   *
   * One cell per beat of the whole exercise, count-in included. At 8 bars that is ~36
   * cells, cheap enough not to bother recycling them.
   *
   * @param {number} beatsPerBar
   * @param {number} totalBeats  including the count-in
   * @param {string[]} countWords one or two words per beat, from the exercise
   */
  setup (beatsPerBar, totalBeats, countWords = []) {
    this.beatsPerBar = beatsPerBar
    this.totalBeats = totalBeats
    this.padsEl.innerHTML = ''
    this.pads = []

    const perBeat = countWords.length && countWords.length % beatsPerBar === 0
      ? countWords.length / beatsPerBar
      : 0

    for (let i = 0; i < totalBeats + VISIBLE_BEATS; i++) {
      const cell = document.createElement('div')
      cell.className = 'cell'
      const inBar = ((i - this.countIn) % beatsPerBar + beatsPerBar) % beatsPerBar
      if (inBar === 0) cell.classList.add('downbeat')

      const bar = document.createElement('div')
      bar.className = 'p'
      cell.append(bar)

      if (perBeat) {
        const words = document.createElement('div')
        words.className = 'w'
        for (let k = 0; k < perBeat; k++) {
          const sp = document.createElement('span')
          const word = countWords[(inBar * perBeat + k) % countWords.length]
          sp.textContent = word
          if (word.startsWith('(') || word === '&') sp.className = 'soft'
          words.append(sp)
        }
        cell.append(words)
      }

      this.padsEl.append(cell)
      this.pads.push(bar)
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

    const rect = this.area.getBoundingClientRect()
    const spacing = rect.width / VISIBLE_BEATS
    const ballX = rect.width * BALL_X
    const bw = this.ball.offsetWidth

    // Slide the strip so that the cell for beat k sits under the ball exactly at
    // phase == k. Under reduced motion the strip steps a whole beat at a time instead
    // of gliding; the beat cue stays, it just stops moving continuously.
    const shown = reduced.matches ? Math.floor(Math.max(0, phase)) : phase
    this.padsEl.style.transform = `translateX(${ballX - shown * spacing - spacing / 2}px)`
    if (this._spacing !== spacing) {
      this._spacing = spacing
      this.padsEl.style.setProperty('--cell', spacing + 'px')
    }

    const beat = Math.floor(phase)
    const f = phase - beat
    const arc = Math.max(40, rect.height * 0.62)
    const y = reduced.matches ? 0 : 4 * arc * f * (1 - f)
    this.ball.style.transform = `translate(${ballX - bw / 2}px, ${-y - 14}px)`

    if (beat !== this._lastPad && phase >= 0) {
      this._lastPad = beat
      this.flashPad(beat)
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
