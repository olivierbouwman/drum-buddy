/**
 * Drum Buddy — app shell and state machine.
 *
 * START -> WARMUP -> PLAY -> DONE
 *
 * Input is deliberately abstracted (see input-sources.js). Right now the only source
 * is taps and the space bar, which makes the whole game playable before the microphone
 * detector is tuned to the real pad. Mic and accelerometer slot in behind the same
 * interface without touching anything in here.
 */

import { TEMPO, BAND, DRUM_NAV, WINDOWS } from './config.js'
import { EXERCISES } from './exercises.js'
import { AudioEngine } from './audio-engine.js'
import { ClickSource } from './click-source.js'
import { Scheduler } from './scheduler.js'
import { Visuals, confetti } from './visuals.js'
import { TapInput } from './input-sources.js'
import { LiveScorer, summarise } from './scoring.js'

const $ = (id) => document.getElementById(id)
const debug = new URLSearchParams(location.search).has('debug')

const engine = new AudioEngine()
let clicks = null
let scheduler = null
let visuals = null
let input = null

const state = {
  bpm: TEMPO.default,
  exerciseIndex: 0,
  scorer: null,
  hits: [],
  notes: [],
  lastStats: null,
}

// ------------------------------------------------------------------ screens

function show (name) {
  for (const el of document.querySelectorAll('.screen')) el.classList.remove('on')
  $('screen-' + name).classList.add('on')
  // Move focus somewhere sensible for keyboard and screen-reader users.
  const first = $('screen-' + name).querySelector('button:not(.ghost), button')
  if (first) first.focus({ preventScroll: true })
}

let toastTimer = null
function toast (msg, ms = 3200) {
  const t = $('toast')
  t.textContent = msg
  t.classList.add('on')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('on'), ms)
}

// ------------------------------------------------------------------ boot

$('btn-play').addEventListener('click', async () => {
  $('btn-play').disabled = true
  try {
    await engine.start()
    clicks = new ClickSource(engine.ctx)
    await clicks.prepare()
    scheduler = new Scheduler(engine, clicks)
    visuals = new Visuals()
    input = new TapInput(engine)
    input.start()

    engine.onStateChange((s) => {
      if (s !== 'running') toast('Tap anywhere to keep going')
    })

    runWarmup()
  } catch (err) {
    toast('Could not start audio: ' + err.message)
    $('btn-play').disabled = false
  }
})

// ------------------------------------------------------------------ warm-up

/**
 * Four hits. Right now this just confirms input works and lets her get a feel for it;
 * once the mic detector lands, these same four hits set sensitivity and pick the
 * sensor. Either way she just sees the band waking up.
 */
function runWarmup () {
  show('warmup')
  const dots = $('warmup-dots')
  dots.innerHTML = ''
  for (let i = 0; i < 4; i++) dots.append(document.createElement('span'))
  const members = [...$('warmup-band').children]

  $('warmup-msg').textContent = 'Hit your pad 4 times to wake the band!'
  let got = 0

  const off = onHits((hit) => {
    if (got >= 4) return
    dots.children[got].classList.add('got')
    const m = members[got % members.length]
    m.classList.remove('sleepy')
    m.classList.add('bounce')
    setTimeout(() => m.classList.remove('bounce'), 200)
    got++
    if (got === 4) {
      off()
      $('warmup-msg').textContent = 'The whole band is up! 🎉'
      setTimeout(() => startExercise(state.exerciseIndex), 700)
    }
  })

  $('btn-skip-warmup').onclick = () => { off(); startExercise(state.exerciseIndex) }
}

/** Subscribe to hits; returns an unsubscribe. */
function onHits (fn) {
  const wrapped = (hit) => fn(hit)
  input.onHit(wrapped)
  return () => {
    const i = input._listeners.indexOf(wrapped)
    if (i >= 0) input._listeners.splice(i, 1)
  }
}

// ------------------------------------------------------------------ play

let offHits = null

function startExercise (index) {
  const ex = EXERCISES[index]
  state.exerciseIndex = index
  state.hits = []
  state.notes = []

  show('play')
  $('ex-name').textContent = ex.name
  $('ex-tip').textContent = ex.tip
  renderCount(ex.count)
  $('bpm-readout').textContent = state.bpm
  $('play-sr').textContent =
    `${ex.name}. ${ex.blurb} ${ex.tip} Count: ${ex.count}. Tempo ${state.bpm} beats per minute.`

  visuals.setup(ex.beatsPerBar)
  visuals.clearHands()
  renderBand(0)
  $('streak').innerHTML = '<b>0</b> in a row'

  const beatS = 60 / state.bpm
  state.scorer = new LiveScorer(beatS)

  scheduler.onClick((beat) => {
    if (!beat.countIn) return
    // Show the count-in digit when the click is actually audible, not when it was
    // scheduled — those are up to 150 ms apart.
    const delay = Math.max(0, engine.audibleAt(beat.time) - performance.now())
    setTimeout(() => {
      const el = $('countin')
      el.textContent = beat.countLabel
      el.classList.add('show')
      setTimeout(() => el.classList.remove('show'), 420)
    }, delay)
  })

  scheduler.onNote((note) => {
    state.notes.push(note)
    state.scorer.addNote(note)
  })

  scheduler.onEnd(() => finishExercise())

  offHits = onHits((hit) => {
    state.hits.push(hit)
    const res = state.scorer.feed(hit)
    if (!res) return
    visuals.showVerdict(res.errorMs)
    updateStreak()
  })

  scheduler.start(ex, state.bpm)
  visuals.start((ts) => scheduler.beatPhase(ts), makeHandReader(beatS))
}

/**
 * Which hand the ball should be showing right now.
 *
 * Only within half a beat of the next note, which is what makes rests work: in the
 * "Waiting game" the ball lands on beats 2 and 4 with nothing to play, and a letter
 * sitting there would invite her to hit. Blank means don't.
 *
 * The same rule handles eighth notes, where half the notes fall at the top of the arc
 * rather than on a landing — the letter simply flips as the ball passes the apex.
 */
function makeHandReader (beatS) {
  let cursor = 0
  return () => {
    const q = scheduler.noteQueue
    if (!q) return null
    const now = engine.now
    // Retire notes that are properly gone. Forward-only, so this stays cheap.
    while (cursor < q.length && now - q[cursor].time > 0.12) cursor++
    const next = q[cursor]
    if (!next) return null
    return next.time - now <= 0.55 * beatS ? next.hand : null
  }
}

function updateStreak () {
  const s = state.scorer
  $('streak').innerHTML = `<b>${s.streak}</b> in a row`
  renderBand(s.streak)
}

/** One word per note, spread across the same width as the pads so they line up. */
function renderCount (count) {
  const host = $('count-words')
  host.innerHTML = ''
  for (const word of count.trim().split(/\s+/)) {
    const el = document.createElement('span')
    el.textContent = word
    // Bracketed counts are rests — say them, don't play them.
    if (word.startsWith('(') || word === '&') el.className = 'soft'
    host.append(el)
  }
}

/** Band members wake up as the streak grows. Nobody ever leaves. */
let bandShown = -1
function renderBand (streak) {
  const host = $('play-band')
  if (bandShown < 0) {
    host.innerHTML = ''
    for (const m of BAND) {
      const el = document.createElement('span')
      el.className = 'member' + (m.at === 0 ? ' lead awake' : '')
      el.textContent = m.emoji
      el.dataset.at = m.at
      host.append(el)
    }
    bandShown = 0
  }
  for (const el of host.children) {
    const at = +el.dataset.at
    const awake = streak >= at
    if (awake && !el.classList.contains('awake')) {
      el.classList.add('awake', 'bounce')
      setTimeout(() => el.classList.remove('bounce'), 220)
      const m = BAND.find((b) => b.at === at)
      if (m && at > 0) toast(m.label + '! 🎵', 1800)
    }
    if (!awake) el.classList.remove('awake')
  }
}

$('btn-quit').addEventListener('click', () => abortToStart())
$('btn-slower').addEventListener('click', () => nudgeTempo(-TEMPO.step))
$('btn-faster').addEventListener('click', () => nudgeTempo(TEMPO.step))

function nudgeTempo (d) {
  state.bpm = Math.min(TEMPO.max, Math.max(TEMPO.min, state.bpm + d))
  $('bpm-readout').textContent = state.bpm
  if (scheduler.running) { stopPlay(); startExercise(state.exerciseIndex) }
}

function stopPlay () {
  scheduler.stop()
  visuals.stop()
  if (offHits) { offHits(); offHits = null }
}

function abortToStart () {
  stopPlay()
  bandShown = -1
  show('start')
  $('btn-play').disabled = false
}

// ------------------------------------------------------------------ done

function finishExercise () {
  stopPlay()
  state.scorer.finish()
  const beatS = 60 / state.bpm
  const stats = summarise(state.notes, state.hits, beatS)
  stats.bestStreak = state.scorer.bestStreak
  state.lastStats = stats

  show('done')
  confetti($('confetti'), stats.stars >= 3 ? 34 : 18)

  $('done-stars').textContent = '⭐'.repeat(stats.stars) + '☆'.repeat(3 - stats.stars)

  if (stats.shift !== 0) {
    $('done-title').textContent = 'Oops!'
    $('done-badge').textContent = stats.shift > 0
      ? 'You were a whole beat behind — try again!'
      : 'You were a whole beat ahead — try again!'
  } else if (!stats.enough) {
    $('done-title').textContent = 'Let’s try that again'
    $('done-badge').textContent = 'I didn’t catch many hits that time'
  } else {
    $('done-title').textContent = 'Fine playing!'
    $('done-badge').textContent = stats.badge
  }

  const dl = $('done-stats')
  dl.innerHTML = ''
  const add = (k, v) => {
    const dt = document.createElement('dt'); dt.textContent = k
    const dd = document.createElement('dd'); dd.textContent = v
    dl.append(dt, dd)
  }
  add('Best streak', `${stats.bestStreak} in a row`)
  add('Hits', `${stats.matched} of ${stats.total}`)
  if (stats.enough && stats.lean !== 'even') {
    add('Today you were', stats.lean === 'quick' ? 'a bit of a 🐰 hare' : 'a bit of a 🐢 tortoise')
  }
  if (debug) {
    add('offset (ms)', Math.round(stats.offsetMs / 5) * 5)
    add('spread (ms)', Math.round(stats.spreadMs / 5) * 5)
    add('drift (bpm)', stats.driftBpm.toFixed(1))
    add('extra hits', stats.extras)
  }

  // Screen-reader summary: the one place a full sentence beats emoji.
  $('done-badge').setAttribute('role', 'status')

  armDrumToContinue()
}

$('btn-again').addEventListener('click', () => { disarm(); startExercise(state.exerciseIndex) })
$('btn-next').addEventListener('click', () => { disarm(); nextExercise() })
$('btn-home').addEventListener('click', () => { disarm(); abortToStart() })

function nextExercise () {
  startExercise((state.exerciseIndex + 1) % EXERCISES.length)
}

/**
 * "Hit twice to keep going." She is holding sticks; making her put them down to tap a
 * screen between every exercise is real friction. Armed on a delay so the last hit of
 * the exercise she just played can't skip her ahead.
 */
let disarm = () => {}
function armDrumToContinue () {
  let recent = []
  let armed = false
  const timer = setTimeout(() => { armed = true }, DRUM_NAV.armDelayMs)

  const off = onHits((hit) => {
    if (!armed) return
    const now = hit.time * 1000
    recent = recent.filter((t) => now - t < DRUM_NAV.withinMs)
    recent.push(now)
    if (recent.length >= DRUM_NAV.hitsNeeded) { disarm(); nextExercise() }
  })

  disarm = () => { clearTimeout(timer); off(); disarm = () => {} }
}

// ------------------------------------------------------------------ snow

/** Frogtown Hollow is always snowing. Decorative; skipped entirely if she'd rather
 *  things held still. */
function makeSnow (count = 26) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const host = $('snow')
  for (let i = 0; i < count; i++) {
    const f = document.createElement('i')
    const size = 3 + Math.random() * 5
    f.style.left = Math.random() * 100 + '%'
    f.style.width = f.style.height = size.toFixed(1) + 'px'
    f.style.opacity = (0.25 + Math.random() * 0.4).toFixed(2)
    f.style.setProperty('--sway', (Math.random() * 80 - 40).toFixed(0) + 'px')
    f.style.animationDuration = (9 + Math.random() * 12).toFixed(1) + 's'
    f.style.animationDelay = (-Math.random() * 20).toFixed(1) + 's'
    host.append(f)
  }
}
makeSnow()

// ------------------------------------------------------------------ misc

// Pause rather than fight background-tab timer throttling. An unattended metronome
// isn't useful anyway.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && scheduler && scheduler.running) {
    stopPlay()
    toast('Paused')
    show('start')
    $('btn-play').disabled = false
  }
})

if (debug) {
  window.drumBuddy = {
    engine, state, startExercise, EXERCISES,
    get stats () { return state.lastStats },
  }
  console.log('[drum-buddy] debug on — window.drumBuddy')
}
