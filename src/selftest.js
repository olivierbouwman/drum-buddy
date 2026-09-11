/**
 * Proves, on real hardware, that the app is not lying about her timing.
 *
 * Everything else is verified against recordings or synthetic data. This is the only
 * check that runs the WHOLE chain on the actual device: speaker, room, microphone,
 * continuous latency calibration, detection and scoring, with no human involved.
 *
 * It plays a synthetic "hit" through the speaker at a known offset from each beat —
 * deliberately late by a fixed amount — and asserts the app reports that offset back.
 *
 * The arithmetic works out exactly, which is what makes this a fair test. A real stick
 * struck at time T is heard at T + inputLatency, and the app subtracts
 * K = outputLatency + inputLatency, so it reports T - noteTime - outputLatency: her
 * error as she perceives it, since she hears the click late by the output latency too.
 * A synthetic hit scheduled at graph time S emerges at S + outputLatency and is heard at
 * S + outputLatency + inputLatency, so after subtracting the same K the app reports
 * exactly S - noteTime. Schedule it 50 ms after the beat and a correct app says +50.
 *
 * A failure here means the numbers she is being shown are wrong, and the app should not
 * be used until it is fixed.
 */

const OFFSET_MS = 50
const BEATS = 16
const TOLERANCE_MS = 15

export class SelfTest {
  constructor ({ engine, clicks, scheduler, timing, input, mic }) {
    this.engine = engine
    this.clicks = clicks
    this.scheduler = scheduler
    this.timing = timing
    this.input = input
    this.mic = mic
    this.errors = []
    this.expected = []
  }

  /**
   * @param {(line:string)=>void} report called with progress lines
   * @returns {Promise<{pass:boolean, median:number|null, spread:number, heard:number, lines:string[]}>}
   */
  async run (report = () => {}) {
    const lines = []
    const say = (l) => { lines.push(l); report(l) }

    if (!this.mic || !this.mic.available) {
      say('No microphone — this test needs one. Nothing was checked.')
      return { pass: false, median: null, spread: 0, heard: 0, lines }
    }

    say(`Playing ${BEATS} fake hits, each ${OFFSET_MS} ms after the beat.`)
    say('Keep quiet and don’t drum. Volume up.')

    const beatS = 1.0
    const start = this.engine.now + 1.0
    const notes = []

    for (let i = 0; i < BEATS; i++) {
      const beat = start + i * beatS
      this.clicks.playAt(i % 4 === 0 ? 'accent' : 'beat', beat)
      this.timing.expectClick(beat)
      // The fake hit: a broadband burst, which is what the detector is tuned to find.
      this.clicks.playAt('calib', beat + OFFSET_MS / 1000)
      notes.push(beat)
    }

    const heard = []
    const off = this.input.onHit
      ? this._listen((hit) => heard.push(this.timing.correct(hit.time)))
      : () => {}

    // Wait for the sequence, plus a moment for the last one to come back.
    await new Promise((r) => setTimeout(r, (BEATS * beatS + 1.6) * 1000))
    off()

    // Match each detected hit to its nearest beat, in order.
    const errs = []
    let n = 0
    for (const beat of notes) {
      let best = null
      let bestGap = Infinity
      for (const h of heard) {
        const gap = (h - beat) * 1000
        if (gap > -200 && gap < 400 && Math.abs(gap - OFFSET_MS) < Math.abs(bestGap - OFFSET_MS)) {
          bestGap = gap
          best = h
        }
      }
      if (best !== null) { errs.push(bestGap); n++ }
    }

    if (n < BEATS / 2) {
      say(`Only heard ${n} of ${BEATS}. Turn the volume up and try again.`)
      return { pass: false, median: null, spread: 0, heard: n, lines }
    }

    const sorted = [...errs].sort((a, b) => a - b)
    const median = sorted[sorted.length >> 1]
    const spread = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b)[sorted.length >> 1] * 1.4826
    const pass = Math.abs(median - OFFSET_MS) <= TOLERANCE_MS

    say(`Heard ${n} of ${BEATS}.`)
    say(`Expected +${OFFSET_MS} ms, measured ${median >= 0 ? '+' : ''}${median.toFixed(1)} ms (spread ${spread.toFixed(1)} ms).`)
    say(`Latency in use: ${this.timing.latencyMs === null ? 'unmeasured' : Math.round(this.timing.latencyMs) + ' ms'}.`)
    say(pass
      ? 'PASS — the timing it shows her is honest.'
      : `FAIL — off by ${(median - OFFSET_MS).toFixed(1)} ms. Do not trust the numbers until fixed.`)

    return { pass, median, spread, heard: n, lines }
  }

  _listen (fn) {
    this.input.onHit(fn)
    return () => {
      const i = this.input._listeners.indexOf(fn)
      if (i >= 0) this.input._listeners.splice(i, 1)
    }
  }
}
