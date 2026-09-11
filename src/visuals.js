/**
 * The bouncing ball and the per-hit feedback.
 *
 * The ball is driven by continuous beat phase, not by beat events. That is deliberate:
 * a ball arcing down toward a pad tells her when the beat is *about* to happen, and
 * anticipation is the actual skill being trained. A flash can only be reacted to.
 */

import { WINDOWS } from './config.js'

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')

/** How far ahead she can see, and where on the lane a note lands. */
const LOOKAHEAD_BEATS = 2.4
const STRIKE_AT = 0.78          // fraction of the lane height

export class Visuals {
  constructor (countIn = 4) {
    this.countIn = countIn
    this.area = document.getElementById('ball-area')
    this.verdict = document.getElementById('verdict')
    this.lane = document.querySelector('.verdict-lane')
    this.lanes = {
      L: {
        notes: document.getElementById('notes-L'),
        strike: document.getElementById('strike-L'),
        el: [],
      },
      R: {
        notes: document.getElementById('notes-R'),
        strike: document.getElementById('strike-R'),
        el: [],
      },
    }
    this._raf = null
  }

  /**
   * @param {object} exercise
   * @param {Array<{time:number,hand:string}>} notes absolute AudioContext times
   * @param {(t:number)=>number} toScreenTime maps context time to the animation clock
   */
  setup (exercise, notes, toScreenTime) {
    this.exercise = exercise
    this.toScreenTime = toScreenTime
    for (const hand of ['L', 'R']) {
      const lane = this.lanes[hand]
      lane.notes.innerHTML = ''
      lane.el = []
    }
    this.notes = notes.map((n) => {
      const el = document.createElement('div')
      el.className = 'note'
      this.lanes[n.hand].notes.append(el)
      const rec = { ...n, el, done: false }
      this.lanes[n.hand].el.push(rec)
      return rec
    })
  }

  start (nowFn) {
    this.stop()
    const tick = () => {
      this.frame(nowFn())
      this._raf = requestAnimationFrame(tick)
    }
    this._raf = requestAnimationFrame(tick)
  }

  stop () {
    if (this._raf) cancelAnimationFrame(this._raf)
    this._raf = null
  }

  /** @param {number} now current time on the same clock the note times use */
  frame (now) {
    if (!this.notes) return
    const rect = this.area.getBoundingClientRect()
    const height = rect.height
    // Where a note lands, and how much of the future is visible.
    const strikeY = height * STRIKE_AT
    const lookahead = LOOKAHEAD_BEATS * this.beatS
    const pxPerSecond = strikeY / lookahead

    for (const hand of ['L', 'R']) {
      const lane = this.lanes[hand]
      lane.strike.style.top = strikeY + 'px'
    }

    for (const n of this.notes) {
      const dt = n.time - now
      if (dt > lookahead + 0.3 || dt < -0.6) {
        if (n.el.style.display !== 'none') n.el.style.display = 'none'
        continue
      }
      n.el.style.display = ''
      const y = strikeY - dt * pxPerSecond
      n.el.style.transform = `translateY(${y - 7}px)`
      if (dt < -0.02 && !n.done) { n.done = true; n.el.classList.add('done') }
    }

  }

  /**
   * Light the pad she just struck, coloured by how close it was.
   *
   * One more channel on top of the words, the emoji and the dot — never the only one,
   * and never red: red/green is the commonest colour-blindness axis, and a red flash
   * would read as failure in an app whose harshest verdict is "Almost!".
   */
  flashPad (hand, kind = 'great') {
    const lane = this.lanes[hand] || this.lanes.R
    const line = lane.strike
    if (!line) return
    line.classList.remove('k-perfect', 'k-great', 'k-almost', 'k-off')
    line.classList.add('lit', 'k-' + kind)
    clearTimeout(lane.flashTimer)
    lane.flashTimer = setTimeout(() => line.classList.remove('lit'), 180)
  }

  showHand () { /* the lanes themselves carry this now */ }
  clearHands () { /* nothing to clear */ }

  /**
   * Show a verdict. Three redundant channels — emoji, words, and where the dot lands
   * on the lane — so nothing depends on colour.
   */
  showVerdict (errorMs) {
    const a = Math.abs(errorMs)
    let kind, text
    if (a <= WINDOWS.perfect) {
      kind = 'perfect'; text = '⭐ Perfect!'
    } else if (a <= WINDOWS.great) {
      // Still a star. Close enough that naming a direction would be reporting noise
      // she can't feel — the dot on the lane carries it if she wants to look.
      kind = 'perfect'; text = '⭐ Nice!'
    } else if (errorMs < 0) {
      kind = 'quick'; text = a <= WINDOWS.almost ? '🐰 A bit quick!' : '🐰 Almost!'
    } else {
      kind = 'slow'; text = a <= WINDOWS.almost ? '🐢 A bit slow!' : '🐢 Almost!'
    }

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

  /**
   * Dots pile up on whichever side she leans — the pattern is the lesson.
   *
   * Deliberately NOT softened along with the wording. The words are the encouraging
   * channel; the dots are the honest one, and a drift she can see accumulating on one
   * side is the single most useful thing on the screen.
   */
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
