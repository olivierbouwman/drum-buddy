/**
 * The bouncing ball and the per-hit feedback.
 *
 * The ball is driven by continuous beat phase, not by beat events. That is deliberate:
 * a ball arcing down toward a pad tells her when the beat is *about* to happen, and
 * anticipation is the actual skill being trained. A flash can only be reacted to.
 */

import { WINDOWS } from './config.js'

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')

/** How far ahead she can see, and where on the lane the stick meets the pad. */
const LOOKAHEAD_BEATS = 2.4
const STRIKE_AT = 0.78          // fraction of the lane height
const HAND_OUT = 0.42           // how far outside the lane the hand sits, in lane widths
const HAND_UP = 0.20            // how high the hand sits, as a fraction of the area
const MAX_SWING_DEG = 62        // how far the stick swings back at the top of the stroke
const IDLE_LIFT = 0.12          // resting height, so a waiting stick doesn't look dead
const APEX = 0.62               // fraction of the stroke spent lifting; the rest is the drop

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
        pad: document.getElementById('pad-L'),
        stick: document.getElementById('stick-L'),
        el: [],
      },
      R: {
        notes: document.getElementById('notes-R'),
        strike: document.getElementById('strike-R'),
        pad: document.getElementById('pad-R'),
        stick: document.getElementById('stick-R'),
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
    // Where the stick meets the pad, and how much of the future is visible.
    const strikeY = height * STRIKE_AT
    const lookahead = LOOKAHEAD_BEATS * this.beatS
    const pxPerSecond = strikeY / lookahead

    /*
     * Place each stick: hand OUTSIDE its lane, bead on the middle of the pad. The stick
     * is the line between those two points, and the hand is the pivot — so its length
     * and resting angle both fall out of the geometry rather than being guessed.
     */
    for (const hand of ['L', 'R']) {
      const lane = this.lanes[hand]
      lane.strike.style.top = strikeY + 'px'
      if (lane.pad) lane.pad.style.top = strikeY + 'px'

      const w = lane.notes.getBoundingClientRect().width || 100
      const pivotX = hand === 'L' ? -w * HAND_OUT : w * (1 + HAND_OUT)
      const pivotY = height * HAND_UP
      const dx = w * 0.5 - pivotX
      const dy = strikeY - pivotY
      const len = Math.hypot(dx, dy)

      lane.geom = { pivotX, pivotY, len, restDeg: (Math.atan2(-dx, dy) * 180) / Math.PI }
      lane.stick.style.left = pivotX + 'px'
      lane.stick.style.top = pivotY + 'px'
      lane.stick.style.height = len + 'px'
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

    for (const hand of ['L', 'R']) {
      this._moveStick(hand, now)
    }
  }

  /**
   * The stroke.
   *
   * Deliberately NOT a pendulum. A real stroke lifts relatively slowly and then
   * accelerates down into the pad, so a symmetric sine would model the wrong motion —
   * and the accelerating drop doubles as a much sharper "now" cue than a smooth one.
   */
  _moveStick (hand, now) {
    const lane = this.lanes[hand]
    const S = Math.min(0.6 * this.beatS, 0.5)

    // The next note this hand has to play, and the one it just played.
    let next = null
    let last = null
    for (const n of lane.el) {
      const dt = n.time - now
      if (dt >= -0.001 && (next === null || n.time < next.time)) next = n
      if (dt < 0 && (last === null || n.time > last.time)) last = n
    }

    let lift = IDLE_LIFT
    if (next && next.time - now <= S) {
      const p = 1 - (next.time - now) / S            // 0 at the start of the lift, 1 at contact
      lift = p < APEX
        ? Math.sin((p / APEX) * (Math.PI / 2))       // slow, easing lift
        : Math.cos(((p - APEX) / (1 - APEX)) * (Math.PI / 2))  // accelerating drop
      lift = IDLE_LIFT + lift * (1 - IDLE_LIFT)
    } else if (last && now - last.time < 0.12) {
      // A small rebound off the pad, decaying away.
      const a = (now - last.time) / 0.12
      lift = IDLE_LIFT + Math.sin(a * Math.PI) * 0.22 * (1 - a)
    }

    /*
     * Lift is a ROTATION about the hand, not a slide — the motion a wrist actually
     * makes. At rest the bead sits on the pad; lifting swings it up and OUTWARD, away
     * from the other stick, so the two never look like they are colliding.
     *
     * A positive CSS rotation moves the bead toward -x, which is why left and right
     * take opposite signs here.
     */
    const g = lane.geom
    if (!g) return
    const away = hand === 'L' ? 1 : -1
    const angle = g.restDeg + lift * MAX_SWING_DEG * away
    lane.stick.style.transform = `translateX(-50%) rotate(${angle.toFixed(1)}deg)`
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
    const pad = lane.pad
    if (!pad) return
    pad.classList.remove('k-perfect', 'k-great', 'k-almost', 'k-off')
    pad.classList.add('lit', 'k-' + kind)
    clearTimeout(lane.padTimer)
    lane.padTimer = setTimeout(() => pad.classList.remove('lit'), 160)
  }

  showHand () { /* the lanes and the sticks carry this now */ }
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
