/**
 * Lookahead metronome scheduler — the "tale of two clocks" pattern.
 *
 * A setInterval tick wakes up often and schedules any clicks falling inside the next
 * lookahead window at exact AudioContext times. The timer only decides *when to think*;
 * the audio clock decides when sound happens, so timer jitter never reaches the beat.
 *
 * It emits two streams:
 *   onClick  - every metronome beat (what she hears)
 *   onNote   - every note the exercise expects her to play (what we score against)
 */

import { SCHEDULER } from './config.js'

export class Scheduler {
  constructor (engine, clicks) {
    this.engine = engine
    this.clicks = clicks
    this.running = false
    this._onClick = () => {}
    this._onNote = () => {}
    this._onEnd = () => {}
  }

  onClick (fn) { this._onClick = fn }
  onNote (fn) { this._onNote = fn }
  onEnd (fn) { this._onEnd = fn }

  /**
   * @param {object} exercise from exercises.js
   * @param {number} bpm
   */
  start (exercise, bpm) {
    this.exercise = exercise
    this.beatS = 60 / bpm
    this.bpm = bpm

    const { beatsPerBar, bars } = exercise
    this.countIn = SCHEDULER.countInBeats
    this.totalBeats = this.countIn + beatsPerBar * bars

    // Everything is scheduled relative to this one instant.
    this.startTime = this.engine.now + 0.25
    this.nextBeat = 0
    this.noteQueue = this._buildNotes()
    this.nextNote = 0
    this.running = true

    this._timer = setInterval(() => this._tick(), SCHEDULER.tickMs)
    this._tick()
    return this.startTime
  }

  /** Absolute AudioContext times for every note she is expected to play. */
  _buildNotes () {
    const out = []
    const { beatsPerBar, bars, notes } = this.exercise
    for (let bar = 0; bar < bars; bar++) {
      for (const n of notes) {
        const beat = this.countIn + bar * beatsPerBar + n.at
        out.push({
          index: out.length,
          bar,
          hand: n.hand,
          beatPos: n.at,
          time: this.startTime + beat * this.beatS,
        })
      }
    }
    return out
  }

  _tick () {
    if (!this.running) return
    const horizon = this.engine.now + SCHEDULER.lookaheadS

    while (this.nextBeat < this.totalBeats) {
      const t = this.startTime + this.nextBeat * this.beatS
      if (t > horizon) break

      const inCountIn = this.nextBeat < this.countIn
      const beatInBar = (this.nextBeat - this.countIn) % this.exercise.beatsPerBar
      const accent = inCountIn ? true : beatInBar === 0

      this.clicks.playAt(accent ? 'accent' : 'beat', t)
      this._onClick({
        index: this.nextBeat,
        time: t,
        accent,
        countIn: inCountIn,
        countLabel: inCountIn ? String(this.nextBeat + 1) : String(beatInBar + 1),
      })
      this.nextBeat++
    }

    while (this.nextNote < this.noteQueue.length) {
      const n = this.noteQueue[this.nextNote]
      if (n.time > horizon) break
      this._onNote(n)
      this.nextNote++
    }

    // Let the last note ring out before ending.
    const endsAt = this.startTime + this.totalBeats * this.beatS
    if (this.engine.now > endsAt + 0.4) {
      this.stop()
      this._onEnd()
    }
  }

  stop () {
    this.running = false
    clearInterval(this._timer)
  }

  /** Fractional beat position right now, for driving the animation. */
  beatPhase (perfNow) {
    const audibleStart = this.engine.audibleAt(this.startTime)
    return (perfNow - audibleStart) / (this.beatS * 1000)
  }
}
