/**
 * Weekly practice, not daily streaks.
 *
 * She has a lesson one day a week and will miss others. The failure to avoid is a run
 * that breaks on an ordinary week, or that dies mid-week before she has had the chance
 * to finish it.
 */
import { weeks } from '../src/history.js'

let passed = 0, failed = 0
const check = (n, c, d = '') => { if (c) { passed++; console.log(`  ok   ${n}`) } else { failed++; console.log(`  FAIL ${n}${d ? '  <- ' + d : ''}`) } }

// A tiny localStorage so history.js can run outside a browser.
const store = {}
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v) },
  removeItem: (k) => { delete store[k] },
}

const DAY = 864e5
const mondayOf = (t) => { const d = new Date(t); d.setHours(0,0,0,0); d.setDate(d.getDate() - ((d.getDay()+6)%7)); return d.getTime() }
const setDays = (offsets) => {
  const base = mondayOf(Date.now())
  store['drum-practice.scores.v1:guest'] = JSON.stringify(
    offsets.map((o) => ({ score: 500, at: base + o * DAY, exercise: 'x', spreadMs: 50 })))
}

console.log('\nweekly goal')
setDays([0, 1, 2, 3])
check('four days this week meets the goal', weeks(4).goalMet)
check('and starts a run of one', weeks(4).weekStreak === 1, String(weeks(4).weekStreak))

setDays([0, 1])
check('two days does not meet it yet', !weeks(4).goalMet)
check('but the run is not broken mid-week', weeks(4).weekStreak === 0, String(weeks(4).weekStreak))

console.log('\na missed day is not a disaster')
setDays([0, 2, 4, 6])
check('four non-consecutive days still count', weeks(4).goalMet, String(weeks(4).thisWeekDays))
check('practising twice in a day counts once',
  (setDays([0, 0, 1, 2, 3]), weeks(4).thisWeekDays === 4), String(weeks(4).thisWeekDays))

console.log('\nruns build across weeks')
{
  const base = mondayOf(Date.now())
  const entries = []
  for (let w = 0; w < 3; w++) for (let d = 0; d < 4; d++) {
    entries.push({ score: 500, at: base - w * 7 * DAY + d * DAY, exercise: 'x', spreadMs: 50 })
  }
  store['drum-practice.scores.v1:guest'] = JSON.stringify(entries)
  check('three good weeks in a row', weeks(4).weekStreak === 3, String(weeks(4).weekStreak))
}
{
  // A weak week two weeks ago ends the run there, but recent weeks still count.
  const base = mondayOf(Date.now())
  const entries = []
  for (const [w, days] of [[0, 4], [1, 4], [2, 1]]) {
    for (let d = 0; d < days; d++) entries.push({ score: 500, at: base - w * 7 * DAY + d * DAY, exercise: 'x', spreadMs: 50 })
  }
  store['drum-practice.scores.v1:guest'] = JSON.stringify(entries)
  check('a poor week ends the run at that point', weeks(4).weekStreak === 2, String(weeks(4).weekStreak))
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
