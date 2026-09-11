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

import { TEMPO, BAND, DRUM_NAV, SCHEDULER, FUSION, CALIBRATION, DETECTOR,
  LEVELS, LEVEL_STORAGE_KEY, applyLevel } from './config.js'
import { EXERCISES } from './exercises.js'
import { AudioEngine } from './audio-engine.js'
import { ClickSource } from './click-source.js'
import { Scheduler } from './scheduler.js'
import { Visuals, confetti } from './visuals.js'
import { TapInput, FusedInput } from './input-sources.js'
import { MicInput } from './onset-detector.js'
import { MotionInput } from './motion-detector.js'
import { TimingModel } from './timing-model.js'
import { probeOffsetSeconds, refractoryForSpacing } from './dsp-core.js'
import { AutoTune } from './auto-tune.js'
import { SelfTest } from './selftest.js'
import { LiveScorer, summarise, scoreFor, notesPerMinute } from './scoring.js'
import * as history from './history.js'
import { assess } from './level-coach.js'

const $ = (id) => document.getElementById(id)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const params = new URLSearchParams(location.search)
const debug = params.has('debug') || params.has('selftest')
const wantSelfTest = params.has('selftest')

const engine = new AudioEngine()
let clicks = null
let scheduler = null
let visuals = null
let input = null
let mic = null
let motion = null
let timing = null
let autoTune = null
/** True only while the metronome is playing and she is meant not to be: the count-in. */
let inSilentWindow = false
/** When the last hit was heard, so contaminated samples can be thrown away. */
let lastHitAt = -1e9
/** When the last click arrived, so "room" samples avoid the click and its tail. */
let lastClickAt = -1e9

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
    visuals = new Visuals(SCHEDULER.countInBeats)

    // The probe reports the peak of a smoothed envelope, which sits partway into the
    // burst rather than at its start. Measure that offset from the click itself rather
    // than guessing — a guess of "half the burst" was 8 ms out.
    const clickPcm = clicks.buffers.beat.getChannelData(0)
    timing = new TimingModel(probeOffsetSeconds(clickPcm, engine.sampleRate, {}))
    seedStoredLatency()

    engine.onStateChange((st) => {
      if (st !== 'running') toast('Tap anywhere to keep going')
    })

    keepAwake()
    show('warmup')
    await setUpSensors()
    if (wantSelfTest) { showSelfTest(); return }
    await runWarmup()
  } catch (err) {
    toast('Could not start: ' + err.message)
    $('btn-play').disabled = false
  }
})

/**
 * Both sensors need the same user gesture that started audio, so they are set up here
 * rather than lazily. Neither is required: if both fail she still gets the metronome
 * and can tap along, which is a real practice tool.
 */
async function setUpSensors () {
  $('warmup-msg').textContent = 'Listening for your drum…'

  mic = new MicInput(engine)
  motion = new MotionInput(engine)

  const [micOk, motionOk] = await Promise.all([
    mic.init().catch(() => false),
    motion.init().catch(() => false),
  ])

  if (micOk) {
    autoTune = new AutoTune(DETECTOR.bands)
    mic.onLevel((peak, levels) => {
      const el = $('warmup-level') || $('play-level')
      if (el) el.style.width = Math.min(100, peak * 160) + '%'
      const p = $('play-level')
      if (p) p.style.width = Math.min(100, peak * 160) + '%'

      // The room itself, sampled only in the gaps: far enough after a click that its
      // tail has died away, and nowhere near a stick.
      if (!levels || !inSilentWindow) return
      const now = engine.now
      if (now - lastClickAt > 0.18 && now - lastHitAt > 0.4) autoTune.sampleRoom(levels)
    })
    // Every click the app plays is a fresh, free measurement of two things: how long
    // the round trip takes, and — when she is definitely not playing — what the
    // metronome bleeding back in actually looks like across the filterbank.
    mic.onClick((t, level, levels) => {
      timing.observeClick(t)
      lastClickAt = t
      // Only trust a bleed sample if she wasn't playing anywhere near it. Telling an
      // eight-year-old to hold still during the count-in would mostly not work; quietly
      // discarding the spoiled samples does.
      const clean = inSilentWindow && Math.abs(t - lastHitAt) > 0.15
      if (clean && levels) autoTune.sampleBleed(levels)
    })
  }

  if (micOk || motionOk) {
    input = new FusedInput({
      mic: micOk ? mic : null,
      motion: motionOk ? motion : null,
      agreeMs: FUSION.agreeMs,
    })
  } else {
    input = new TapInput(engine)
  }
  input.start()

  if (!micOk) {
    // Nothing can hear the click come back, so K can only be estimated: a tap is
    // stamped from the event itself, and the delay that matters is how late she HEARS
    // the beat. Approximate, and flagged as such, but far better than refusing to score.
    timing.setEstimated(engine.outputLatency || 0.02)
  }

  // In debug, taps stay live alongside the real sensors for testing on a desktop.
  if (debug && (micOk || motionOk)) {
    const tap = new TapInput(engine)
    tap.onHit((h) => input.emit({ ...h, timingTrusted: true }))
    tap.start()
  }

  reportSensors(micOk, motionOk)
}

function reportSensors (micOk, motionOk) {
  const bits = []
  if (micOk) bits.push('microphone')
  if (motionOk) bits.push('pad wobble')
  if (!bits.length) {
    toast('No microphone — tap the screen to play along', 5000)
  } else if (mic && mic.processing.length) {
    // Android and Safari sometimes ignore the constraints; worth knowing in debug.
    if (debug) toast('Mic processing still on: ' + mic.processing.join(', '), 6000)
  }
  if (debug) console.log('[drum-buddy] sensors:', { micOk, motionOk, micError: mic && mic.error, motionError: motion && motion.error })
}

/**
 * Reuse the last measured latency as a starting point so the first few beats are not
 * wildly wrong. It is only a seed: live measurements replace it within a few clicks,
 * and the number drifts enough between sessions that trusting a stored one would be
 * exactly the "lying to a child" failure this app exists to avoid.
 */
function seedStoredLatency () {
  try {
    const raw = localStorage.getItem(CALIBRATION.storageKey)
    if (!raw) return
    const v = JSON.parse(raw)
    if (v && v.sampleRate === engine.sampleRate && typeof v.latencyMs === 'number') {
      timing.latencyS = v.latencyMs / 1000
    }
  } catch { /* storage unavailable or corrupt; a seed is optional */ }
}

function storeLatency () {
  try {
    if (timing && timing.usable) {
      localStorage.setItem(CALIBRATION.storageKey, JSON.stringify({
        latencyMs: Math.round(timing.latencyMs),
        sampleRate: engine.sampleRate,
      }))
    }
  } catch { /* not important enough to bother her about */ }
}

// ------------------------------------------------------------------ warm-up

/**
 * The warm-up does three real jobs, and looks like the band waking up.
 *
 * First a handful of soft clicks with nobody drumming: that measures the round-trip
 * latency AND what the metronome bleeding back through the microphone looks like across
 * the filterbank. Then four hits from her, which measures what her drum looks like. The
 * difference between those two is what tells the app which frequencies to listen to on
 * this device, in this room — the thing that used to need an offline recording session.
 *
 * She just sees the animals wake up.
 */
async function runWarmup () {
  const dots = $('warmup-dots')
  const members = [...$('warmup-band').children]
  dots.innerHTML = ''

  // --- listening phase: metronome only, nobody playing ---
  $('warmup-msg').textContent = 'Shhh… listening to your room 🤫'
  inSilentWindow = true
  const gap = 0.42
  let t = engine.now + 0.25
  for (let i = 0; i < 7; i++) {
    clicks.playAt(i === 0 ? 'accent' : 'beat', t)
    timing.expectClick(t)
    const when = Math.max(0, engine.audibleAt(t) - performance.now())
    setTimeout(() => {
      const m = members[i % members.length]
      m.classList.remove('sleepy')
      m.classList.add('bounce')
      setTimeout(() => m.classList.remove('bounce'), 200)
    }, when)
    t += gap
  }
  await sleep((t - engine.now) * 1000 + 150)
  inSilentWindow = false

  // --- her turn ---
  for (let i = 0; i < 4; i++) dots.append(document.createElement('span'))
  $('warmup-msg').textContent = 'Now hit your pad 4 times!'

  let got = 0
  const off = onHits((hit) => {
    lastHitAt = hit.time
    if (got >= 4) return
    dots.children[got].classList.add('got')
    const m = members[got % members.length]
    m.classList.add('bounce')
    setTimeout(() => m.classList.remove('bounce'), 200)
    got++
    if (got === 4) {
      off()
      $('warmup-msg').textContent = 'The whole band is up! 🎉'
      applyAutoTune()
      setTimeout(() => startExercise(state.exerciseIndex), 700)
    }
  })

  // Never strand her here: if the pad is too quiet or the mic is blocked, go anyway.
  const bail = setTimeout(() => {
    if (got < 4) {
      off()
      if (got === 0) toast('I couldn’t hear your drum — you can tap the screen too', 5000)
      applyAutoTune()
      startExercise(state.exerciseIndex)
    }
  }, 15000)

  $('btn-skip-warmup').onclick = () => { clearTimeout(bail); off(); applyAutoTune(); startExercise(state.exerciseIndex) }
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
  // Always tear down first. Without this a second call while one is running leaves the
  // old hit listener subscribed, and every hit gets recorded twice — which shows up as
  // a pile of phantom "extra hits" rather than as an obvious crash.
  stopPlay()

  const ex = EXERCISES[index]
  state.exerciseIndex = index
  state.hits = []
  state.notes = []

  show('play')
  $('ex-name').textContent = ex.name
  $('ex-tip').textContent = ex.tip
  $('bpm-readout').textContent = state.bpm
  $('play-sr').textContent =
    `${ex.name}. ${ex.blurb} ${ex.tip} Count: ${ex.count}. Tempo ${state.bpm} beats per minute.`

  visuals.setup(ex.beatsPerBar, SCHEDULER.countInBeats + ex.beatsPerBar * ex.bars,
    ex.count.trim().split(/\s+/))
  visuals.clearHands()
  renderBand(0)
  $('streak').innerHTML = '<b>0</b> in a row'

  const beatS = 60 / state.bpm
  state.scorer = new LiveScorer(beatS)

  scheduler.onClick((beat) => {
    // Tell the timing model when we asked for this click; the microphone will report
    // when it actually came back, and the gap keeps K current.
    timing.expectClick(beat.time)

    // Bleed can only be measured honestly while she is definitely not playing. The
    // count-in guarantees exactly that, at the start of every single exercise — so the
    // app keeps re-learning this room for free and never needs a setup step.
    inSilentWindow = beat.countIn
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
    // Everything measured stays in AudioContext time; K is subtracted here and nowhere
    // else. See the invariant at the top of timing-model.js.
    const corrected = { ...hit, time: timing.correct(hit.time) }
    state.hits.push(corrected)
    lastHitAt = hit.time
    if (autoTune && hit.levels) autoTune.sampleHit(hit.levels)

    if (!timing.usable) {
      // Refuse to grade until the latency is known. Reporting timing against an
      // unmeasured 350 ms delay would mark a perfectly good hit as hopelessly late.
      visuals.missed()
      return
    }
    const res = state.scorer.feed(corrected)
    if (!res) return
    visuals.showVerdict(res.errorMs)
    updateStreak()
  })

  // Shortest gap this exercise actually asks for, so double-hit rejection is generous
  // on slow exercises and tight on fast ones.
  const offsets = ex.notes.map((n) => n.at).sort((a, b) => a - b)
  let minGap = ex.beatsPerBar
  for (let i = 1; i < offsets.length; i++) minGap = Math.min(minGap, offsets[i] - offsets[i - 1])
  if (mic && mic.available) mic.setRefractoryMs(refractoryForSpacing(minGap * beatS))

  scheduler.start(ex, state.bpm)
  visuals.start((ts) => scheduler.beatPhase(ts), makeHandReader(beatS))

  // By the end of the count-in the microphone should have heard several clicks. If it
  // hasn't, the volume is down or the speaker is muted — say so, because otherwise she
  // just plays into a screen that never responds.
  clearTimeout(calibWatch)
  calibWatch = setTimeout(() => {
    if (scheduler.running && !timing.usable) {
      toast(timing.status === 'unstable'
        ? 'The beat keeps shifting — let’s try again in a moment'
        : 'I can’t hear the beep — is the volume up?', 6000)
    }
  }, (SCHEDULER.countInBeats + 1) * beatS * 1000)
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

let calibWatch = null

function stopPlay () {
  clearTimeout(calibWatch)
  inSilentWindow = false
  scheduler.stop()
  visuals.stop()
  if (offHits) { offHits(); offHits = null }
}

function abortToStart () {
  stopPlay()
  letSleep()
  bandShown = -1
  show('start')
  $('btn-play').disabled = false
}

// ------------------------------------------------------------------ done

function finishExercise () {
  stopPlay()
  storeLatency()
  applyAutoTune()
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
    add('latency (ms)', timing.latencyMs === null ? 'unmeasured' : Math.round(timing.latencyMs))
    add('latency drift', Math.round(timing.spreadMs * 10) / 10 + ' ms')
    add('timing from', input.timingSource || 'tap')
    if (autoTune && autoTune.ready) {
      add('bands in use', autoTune.report.bands.filter((b) => b.on).map((b) => b.hz).join(' '))
      add('worst margin', Math.min(...autoTune.report.bands.filter((b) => b.on)
        .map((b) => b.marginDb)) + ' dB')
      if (autoTune.report.problem) add('tuning', autoTune.report.problem)
    }
    if (input.corroborationRate !== null && input.corroborationRate !== undefined) {
      add('pad confirmed', Math.round(input.corroborationRate * 100) + '%')
    }
    add('offset (ms)', Math.round(stats.offsetMs / 5) * 5)
    add('spread (ms)', Math.round(stats.spreadMs / 5) * 5)
    add('drift (bpm)', stats.driftBpm.toFixed(1))
    add('extra hits', stats.extras)
  }

  // One number that combines the lot — see scoreFor() for what it weighs and why.
  // Runs after the title is set, because a personal best rewrites it.
  const score = scoreFor(stats, notesPerMinute(EXERCISES[state.exerciseIndex], state.bpm))
  renderScore(score, EXERCISES[state.exerciseIndex].id)

  // Let the coach decide whether the app should get fussier or kinder from here.
  if (stats.enough) maybeChangeLevel()

  // Screen-reader summary: the one place a full sentence beats emoji.
  $('done-badge').setAttribute('role', 'status')

  armDrumToContinue()
}

/**
 * Push what the learner has worked out down to the detector.
 *
 * Applied between exercises rather than mid-attempt: switching bands changes which
 * hits get seen, and doing that halfway through would make one attempt incomparable
 * with itself.
 */
function applyAutoTune () {
  if (!autoTune || !mic || !mic.available) return
  const decision = autoTune.decide()
  if (!decision) return
  if (autoTune.report.noisyRoom) toast('It’s a bit noisy in here — I’ll do my best', 4000)
  if (!decision.changed) return
  mic.tune(decision)
  if (debug) console.log('[drum-buddy] retuned:', autoTune.report)
}

/**
 * The score, plus how it moved.
 *
 * Only ever framed as progress. A lower score shows a shorter bar rather than a red
 * number, the running best stays in view so one bad attempt never erases a good one,
 * and beating her own record gets its own moment.
 */
function renderScore (score, exerciseId) {
  const box = $('scorebox')
  if (score === null) { box.hidden = true; return }
  box.hidden = false

  const h = history.record({
    score,
    exercise: exerciseId,
    bpm: state.bpm,
    spreadMs: state.lastStats ? state.lastStats.spreadMs : undefined,
    level: level.id,
  })

  $('score-value').textContent = score

  const delta = $('score-delta')
  if (h.previous === null) {
    delta.textContent = 'your first score!'
    delta.className = 'up'
  } else if (score > h.previous) {
    delta.textContent = `+${score - h.previous} better than last time`
    delta.className = 'up'
  } else if (score === h.previous) {
    delta.textContent = 'same as last time'
    delta.className = ''
  } else {
    delta.textContent = `last time ${h.previous}`
    delta.className = ''
  }

  // Best ever only when it isn't simply today's best repeated back at her.
  const bests = []
  if (h.attemptsToday > 1) bests.push(`best today ${h.bestToday}`)
  if (h.bestEver > h.bestToday) bests.push(`best ever ${h.bestEver}`)
  $('score-best').textContent = bests.join(' · ')

  const spark = $('score-spark')
  spark.innerHTML = ''
  const top = Math.max(...h.recent, 1)
  h.recent.forEach((v, i) => {
    const bar = document.createElement('i')
    bar.style.height = Math.max(4, Math.round((v / top) * 26)) + 'px'
    if (v === top) bar.classList.add('best')
    if (i === h.recent.length - 1) bar.classList.add('now')
    spark.append(bar)
  })

  if (h.isBestEver) {
    $('done-title').textContent = 'New best ever! 🎉'
    confetti($('confetti'), 40)
    toast('That is your best score yet!', 4000)
  } else if (h.isBestToday) {
    toast('Best of the day so far!', 3000)
  }

  $('play-sr').textContent =
    `Score ${score}. ${delta.textContent}. ${bests.join('. ')}`
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

// -------------------------------------------------------------- self-test

/**
 * `?selftest` — the only check that runs the whole chain on real hardware.
 *
 * Everything else is verified against recordings or synthetic data. This plays fake
 * hits at a known offset through the actual speaker and asserts the app reports that
 * offset back. It is what to run on a new device, and what to run first if the feedback
 * ever looks wrong.
 */
function showSelfTest () {
  show('selftest')
  const log = $('st-log')
  const verdict = $('st-verdict')
  log.textContent = 'Ready. Turn the volume up, put the device where she practises,\nthen press Run.\n'
  verdict.textContent = ''
  verdict.className = 'verdict-big'

  $('st-back').onclick = () => { show('start'); $('btn-play').disabled = false }
  $('st-run').onclick = async () => {
    $('st-run').disabled = true
    log.textContent = ''
    verdict.textContent = ''
    verdict.className = 'verdict-big'
    const test = new SelfTest({ engine, clicks, scheduler, timing, input, mic })
    const result = await test.run((line) => { log.textContent += line + '\n' })
    verdict.textContent = result.pass ? '✅ PASS' : '❌ FAIL'
    verdict.className = 'verdict-big ' + (result.pass ? 'pass' : 'fail')
    $('st-run').disabled = false
    $('st-run').textContent = 'Run again'
  }
}

// ------------------------------------------------------------ difficulty

/**
 * How fussy the app is about timing.
 *
 * A single fixed window can't serve a complete beginner and the same child six months
 * later: tight enough to be meaningful later is demoralising now, and generous enough
 * to be kind now stops telling her anything once she improves. So it's a setting, with
 * kid-legible names rather than numbers.
 *
 * Persisted, like the latency measurement, because it describes the setup rather than
 * how she did — scores still reset every session.
 */
let level = LEVELS[0]
let autoLevel = true

function loadLevel () {
  try {
    const id = localStorage.getItem(LEVEL_STORAGE_KEY)
    autoLevel = id === null || id === 'auto'
    const found = LEVELS.find((l) => l.id === id)
    if (found) level = found
    if (autoLevel) {
      const savedAuto = LEVELS.find((l) => l.id === localStorage.getItem(LEVEL_STORAGE_KEY + '.auto'))
      if (savedAuto) level = savedAuto
    }
  } catch { /* storage unavailable; the default is fine */ }
  applyLevel(level)
}

function setLevel (l, { announce } = {}) {
  level = l
  applyLevel(level)
  try {
    if (autoLevel) localStorage.setItem(LEVEL_STORAGE_KEY + '.auto', l.id)
  } catch {}
  renderLevels()
  if (announce) toast(announce, 4500)
}

/**
 * After each attempt, decide whether the app should get fussier or kinder.
 * Promotion is a celebration; easing back happens quietly, because telling a child the
 * app thinks she got worse is the opposite of the point.
 */
function maybeChangeLevel () {
  if (!autoLevel) return
  const verdict = assess(history.recentSpreads(5), LEVELS.indexOf(level),
    history.attemptsAtLevel(level.id), LEVELS)
  if (debug) console.log('[drum-buddy] level:', verdict.direction, verdict.reason)
  if (verdict.direction === 'stay') return
  const next = LEVELS[verdict.index]
  setLevel(next, {
    announce: verdict.direction === 'up'
      ? `You levelled up! Now on "${next.name}" ⭐`
      : undefined,
  })
}

function renderLevels () {
  const host = $('level-buttons')
  host.innerHTML = ''

  const auto = document.createElement('button')
  auto.type = 'button'
  auto.textContent = autoLevel ? `Auto · ${level.name}` : 'Auto'
  auto.setAttribute('aria-pressed', String(autoLevel))
  auto.addEventListener('click', () => {
    autoLevel = true
    try { localStorage.setItem(LEVEL_STORAGE_KEY, 'auto') } catch {}
    renderLevels()
    toast('I’ll pick the level as you improve', 2500)
  })
  host.append(auto)

  for (const l of LEVELS) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = l.name
    b.setAttribute('aria-pressed', String(!autoLevel && l.id === level.id))
    b.addEventListener('click', () => {
      autoLevel = false
      try { localStorage.setItem(LEVEL_STORAGE_KEY, l.id) } catch {}
      setLevel(l, { announce: `Timing check: ${l.name}` })
    })
    host.append(b)
  }
}

loadLevel()
renderLevels()

// ---------------------------------------------------------- screen and sleep

/**
 * Keep the screen on while she is practising.
 *
 * A tablet sleeping after 30 seconds is fatal here: she is holding sticks and hitting a
 * pad, so she never touches the screen and the OS has no idea she is still using it.
 *
 * The lock is dropped automatically whenever the page is hidden, so it has to be taken
 * again on the way back.
 */
let wakeLock = null

async function keepAwake () {
  if (!('wakeLock' in navigator) || wakeLock) return
  try {
    wakeLock = await navigator.wakeLock.request('screen')
    wakeLock.addEventListener('release', () => { wakeLock = null })
  } catch {
    // Denied, unsupported, or the tab isn't visible. Not worth bothering her about.
  }
}

async function letSleep () {
  try { if (wakeLock) await wakeLock.release() } catch { /* already gone */ }
  wakeLock = null
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !$('screen-start').classList.contains('on')) keepAwake()
})

/**
 * Full-screen toggle, for when it's opened as a normal browser tab rather than
 * installed. Hidden when it can't work (iOS Safari won't full-screen a document) or
 * when it's pointless (already installed and running full screen).
 */
const canFullscreen = !!document.documentElement.requestFullscreen
const installed = window.matchMedia('(display-mode: fullscreen)').matches ||
                  window.matchMedia('(display-mode: standalone)').matches ||
                  window.navigator.standalone === true

if (canFullscreen && !installed) {
  const btn = $('btn-fullscreen')
  btn.hidden = false
  const sync = () => {
    btn.textContent = document.fullscreenElement ? '⛶ Exit full screen' : '⛶ Full screen'
  }
  btn.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await document.documentElement.requestFullscreen({ navigationUI: 'hide' })
    } catch { /* the browser said no; the button just does nothing */ }
  })
  document.addEventListener('fullscreenchange', sync)
  sync()
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
    engine, state, startExercise, finishExercise, EXERCISES,
    get stats () { return state.lastStats },
  }
  console.log('[drum-buddy] debug on — window.drumBuddy')
}
