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

import { TEMPO, DRUM_NAV, SCHEDULER, FUSION, CALIBRATION, DETECTOR, WEEK, MOTION,
  LEVELS, LEVEL_STORAGE_KEY, applyLevel } from './config.js'
import { EXERCISES, byId } from './exercises.js'
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
import { startDiagnostics, sendSession, wavFromFloat, diagnosticsActive } from './diagnostics.js'
import { LiveScorer, summarise, scoreFor, notesPerMinute } from './scoring.js'
import * as history from './history.js'
import * as players from './players.js'
import { buildPlan, bonusStep } from './practice-plan.js'
import { assess } from './level-coach.js'

const $ = (id) => document.getElementById(id)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const params = new URLSearchParams(location.search)
const debug = params.has('debug') || params.has('selftest')
// The pad sensor's delay is a property of the device, not of the day. Measured once on
// something new, then left alone; see the note in runWarmup().
const wantsCalibration = params.has('calibrate')
/*
 * Speaker test: can the accelerometer feel the tablet's own speaker?
 *
 * If it can, the gap between a click being scheduled and the case moving IS the output
 * latency, measured directly on the device with no microphone and no human in the loop —
 * which is the one reference that has been missing. Run it, put the tablet where she
 * plays, and do not touch anything.
 */
const speakerTest = params.has('speakertest')
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
  /** How hard she actually hits, so room noise can be told apart from a real strike. */
  hitStrengths: [],
  /** Today's plan, and where we are in it. */
  plan: null,
  stepIndex: 0,
  sessionStars: 0,
  sessionScores: [],
  /** Every detection this exercise, with its features — for offline replay. */
  detections: [],
  /** The accelerometer trace, so the two sensors can be compared after the fact. */
  motionTrace: [],
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
  /*
   * AUDIO FIRST, then full screen.
   *
   * Both need the user gesture that got us here, and only one of them matters. Asking
   * for full screen first consumed the activation and left AudioContext.resume() with
   * none — on the tablet it simply never resolved, so the screen never changed, no error
   * was thrown and Play looked dead.
   *
   * Full screen is fired afterwards and deliberately not awaited: it is cosmetic, and
   * nothing should wait on it.
   */
  /*
   * BOTH calls have to happen synchronously in this handler.
   *
   * A browser only honours full screen and audio start while the tap that triggered
   * them is still "active", and that activation does not survive an await. Asking for
   * full screen first broke audio; awaiting audio first broke full screen — the request
   * was made and then simply hung, never granted and never refused.
   *
   * So both are kicked off before anything is awaited, and only then is the audio
   * waited on.
   */
  goFullscreen()
  const audioReady = engine.start()
  try {
    await withTimeout(audioReady, 5000, 'audio')
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

    setInterval(watchForSilentMic, 1000)

    keepAwake()
    show('warmup')
    await setUpSensors()
    if (wantSelfTest) { showSelfTest(); return }
    await runWarmup()
  } catch (err) {
    // Never fail silently here. A dead Play button with no explanation is the worst
    // possible first impression, and it is exactly what happened.
    toast(err.message === 'audio'
      ? 'Sound could not start — try tapping Play again'
      : 'Could not start: ' + err.message, 6000)
    $('btn-play').disabled = false
    if (debug) console.error('[drum-buddy] start failed:', err)
  }
})

/** Reject rather than hang. A promise that never settles is invisible from the outside. */
function withTimeout (promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ])
}

/**
 * Both sensors need the same user gesture that started audio, so they are set up here
 * rather than lazily. Neither is required: if both fail she still gets the metronome
 * and can tap along, which is a real practice tool.
 */
async function setUpSensors () {
  $('warmup-msg').textContent = 'Listening for your drum…'

  // A rolling window of raw audio, kept only when a developer machine is serving the
  // page. The published app never records anything.
  mic = new MicInput(engine, { recordSeconds: diagnosticsActive ? 45 : 0 })
  motion = new MotionInput(engine)

  const [micOk, motionOk] = await Promise.all([
    mic.init().catch(() => false),
    motion.init().catch(() => false),
  ])

  if (micOk) {
    autoTune = new AutoTune(DETECTOR.bands)
    mic.onLevel((peak, levels) => {
      setMeter('level', peak * 1.6)
      watchForDeafness(peak)

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

  if (motionOk) {
    motion.onLevel((v, mag) => {
      setMeter('motion', v)
      if ((diagnosticsActive || speakerTest) && scheduler && scheduler.running && state.motionTrace.length < 20000) {
        // nowFine: the raw clock steps 85 ms at a time, which would smear the trace
        // across the very interval any speaker-borne signal has to be found in.
        // Third column is the gravity-inclusive magnitude: the only one of the two that
        // still has dither in it when the tablet is completely still.
        state.motionTrace.push([
          +engine.nowFine.toFixed(4),
          +(mag || 0).toFixed(4),
          motion.rawG === null || motion.rawG === undefined ? null : +motion.rawG.toFixed(5),
        ])
      }
    })
  } else {
    for (const id of ['warmup-motion-row', 'play-motion-row']) {
      const el = $(id)
      if (el) el.classList.add('off')
    }
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

/*
 * WHAT EACH SENSOR IS FOR
 *
 * The pad sensor decides WHEN SHE HIT. It is immune to the metronome bleeding out of
 * the speaker and to a noisy room, needs no per-room tuning, and on the real tablet
 * finds her notes with about 30 ms of spread.
 *
 * The microphone no longer scores anything. It keeps two jobs the pad cannot do:
 *
 *   1. Measuring how late everything is. Its own click, heard coming back, is the only
 *      objective latency reference available — and without one, "never tell an on-time
 *      child she is late" is just a hope. This part has been completely reliable
 *      throughout: every measurement, on every run, steady to a fraction of a
 *      millisecond.
 *   2. Standing in when there is no pad sensor at all, such as on a laptop.
 *
 * Its detection still runs, but only so a strike seen by both sensors can pin down the
 * pad's correction exactly. If the microphone hears nothing, that just falls back to the
 * screen-tap measurement; nothing else degrades.
 */
function reportSensors (micOk, motionOk) {
  const bits = []
  if (motionOk) bits.push('pad wobble')
  if (micOk) bits.push('microphone')
  if (!bits.length) {
    toast('No microphone or pad sensor — tap the screen to play along', 5000)
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

/**
 * Guarantee a latency value exists, so nothing downstream ever has to cope with "we
 * don't know". Ordered best to worst: a live measurement, last session's, the browser's
 * own output-latency estimate doubled to stand in for the return trip.
 */
function ensureLatency () {
  if (timing.usable) return
  let seconds = null
  try {
    const raw = localStorage.getItem(CALIBRATION.storageKey)
    if (raw) {
      const v = JSON.parse(raw)
      if (v && typeof v.latencyMs === 'number') seconds = v.latencyMs / 1000
    }
  } catch { /* storage unavailable */ }
  if (seconds === null) seconds = (engine.outputLatency || 0.02) * 2
  timing.setEstimated(seconds)
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
  const progress = $('warmup-progress')
  dots.innerHTML = ''
  if (progress) progress.hidden = true

  /*
   * The warm-up is one step now: hit the pad four times.
   *
   * Two steps came out. Five clicks played to nobody measured the microphone's round
   * trip, which nothing uses any more — the pad is the timing source, and its correction
   * is the browser's own output latency plus a sensor delay of about fifteen
   * milliseconds. The volume check riding along with it tested `timing.usable`, which is
   * true whenever ANY latency number exists, last session's included, so it could never
   * fire. Five seconds, a number nobody reads, and a warning that never appears.
   *
   * The four hits stay. They are the only part she was ever doing on purpose: they set
   * how hard she plays today, which is what arms drumming-to-start, and they are
   * drumming rather than instructions.
   */

  /*
   * How late is the pad sensor? About fifteen milliseconds, and measuring it costs more
   * than knowing it.
   *
   * Five paced taps on a circle produced [21, -3, 22, 5] on her tablet: a median of 13
   * against a spread of 23, so the measurement's own noise was larger than the thing it
   * measured, and one reading claimed the sensor reported the tap before it happened.
   * The constant is within about ten milliseconds of every reading ever taken here,
   * which is a seventh of the perfect window — and it is six seconds shorter and has no
   * instructions to misunderstand.
   *
   * Still measurable on a device this has never seen: add ?calibrate to the URL.
   */
  if (wantsCalibration) await measureMotionDelay()
  else useDefaultPadDelay()

  // --- her turn ---
  for (let i = 0; i < 4; i++) dots.append(document.createElement('span'))
  $('warmup-msg').textContent = 'Now hit your pad 4 times!'

  let got = 0
  warmupHits = []
  const off = onHits((hit) => {
    lastHitAt = hit.time
    // One strike checking off two dots means two events for one hit; the gap between
    // them says whether it is the sensor ringing or a listener subscribed twice.
    if (warmupHits.length < 30) {
      warmupHits.push([+hit.time.toFixed(3), +(hit.strength || 0).toFixed(2), hit.source])
    }
    /*
     * These count toward how hard she plays. Without them the drum-to-start and
     * drum-to-continue shortcuts never arm on a fresh session: they refuse to guess at
     * a threshold, and the only hits they had ever seen came from exercises that had
     * not happened yet.
     */
    if (typeof hit.strength === 'number') {
      state.hitStrengths.push(hit.strength)
      if (state.hitStrengths.length > 120) state.hitStrengths.shift()
    }
    if (got >= 4) return
    dots.children[got].classList.add('got')
    got++
    if (got === 4) {
      off()
      clearTimeout(bail)             // finished: stop the 15-second rescue
      $('warmup-msg').textContent = 'Got it! 🎉'
      applyAutoTune()
      setTimeout(showToday, 700)
    }
  })

  // Never strand her here: if the pad is too quiet or the mic is blocked, go anyway.
  // eslint-disable-next-line prefer-const
  let bail
  bail = setTimeout(() => {
    if (got < 4) {
      off()
      if (got === 0) toast('I couldn’t hear your drum — you can tap the screen too', 5000)
      applyAutoTune()
      showToday()
    }
  }, 15000)

  $('btn-skip-warmup').onclick = () => { clearTimeout(bail); off(); applyAutoTune(); showToday() }
}

/** Drive both meters at once; they exist on the warm-up and the practice screens. */
function setMeter (which, fraction) {
  const w = Math.max(0, Math.min(100, fraction * 100))
  for (const id of ['warmup-' + which, 'play-' + which]) {
    const el = $(id)
    if (el) el.style.width = w + '%'
  }
}

/**
 * Never be silently deaf.
 *
 * The learned level gate is meant to reject the metronome, but a gate set from too few
 * or too loud a sample can reject HER — and from her side that looks exactly like the
 * app ignoring her, with no clue why. So watch: if the microphone is clearly picking up
 * sound during an exercise and yet nothing is being detected, throw the gate away and
 * reopen every band. A false trigger is a far smaller failure than deafness.
 */
let loudSince = 0
let deafnessHandled = false

/**
 * A microphone that was granted but delivers nothing.
 *
 * Distinct from deafness: there is no audio at all, so no threshold change can help.
 * Measured on the tablet — a whole exercise produced 51 ms of silence, zero detections,
 * and an app still cheerfully reporting the microphone as available.
 */
let micSilentSince = 0
let reacquiring = false
let micSilenceReported = false
let micAttempts = 0

async function watchForSilentMic () {
  if (!mic || !mic.available || reacquiring) return
  const now = Date.now()
  if (mic.receiving) { micSilentSince = 0; return }
  if (!micSilentSince) { micSilentSince = now; return }
  if (now - micSilentSince < 2500) return

  /*
   * Give up after a couple of attempts.
   *
   * Retrying every few seconds tore down a stream and opened another over and over,
   * walked the constraint ladder off its end and left the session with no microphone at
   * all. The retry destroyed the thing it was retrying. Two goes, then leave it be: the
   * pad sensor is what scores her playing, and a microphone that will not deliver is a
   * lost calibration, not a lost session.
   */
  if (micAttempts >= 2) return
  micAttempts++

  reacquiring = true
  micSilentSince = 0
  const ok = await mic.reacquire()
  /*
   * If it is still silent after a fresh stream, the microphone is being withheld rather
   * than being quiet — most often Android's own microphone toggle, which hands apps
   * silence instead of refusing them. Said once, and gently: the pad sensor is what
   * scores her playing, and it works regardless.
   */
  /*
   * Said nothing, deliberately.
   *
   * The microphone scores nothing, times nothing and checks nothing any more — it is a
   * fallback for a tablet that cannot feel the pad, and this tablet can. Announcing its
   * silence during the four warm-up hits was reporting a problem she does not have,
   * about a part she does not use, in the middle of the one thing she came to do.
   * It stays in the diagnostics, where it belongs.
   */
  if (debug) console.warn('[drum-buddy] microphone delivered nothing; re-acquired:', ok)
  setTimeout(() => { reacquiring = false }, 8000)
  // Even if that fails she keeps playing: the pad sensor picks the exercise up.
  if (!ok && motion && motion.available) toast('Using the pad sensor', 2500)
}

function watchForDeafness (peak) {
  if (!scheduler || !scheduler.running || !mic || !mic.available) { loudSince = 0; return }
  const now = engine.now
  if (peak < 0.02) { loudSince = 0; return }          // nothing to hear; not deafness
  if (!loudSince) loudSince = now
  if (deafnessHandled) return
  if (now - lastHitAt < 3) { loudSince = 0; return }  // hits are arriving; all is well

  if (now - loudSince > 4) {
    deafnessHandled = true
    mic.tune({ mask: DETECTOR.bands.map(() => 1), minLevel: 0 })
    if (autoTune) autoTune.minLevel = 0
    toast('Listening harder…', 2500)
    if (debug) console.warn('[drum-buddy] deafness watchdog fired — gate and bands reset')
  }
}

/**
 * Work out how late the accelerometer reports a strike, by tapping the screen.
 *
 * A tap and the jolt it puts through the tablet are the SAME physical event seen by two
 * different sensors, and the touchscreen reports essentially instantly. So the gap
 * between them is the accelerometer's own delay, measured with no human timing involved
 * — which is what makes it trustworthy. Nothing here depends on her being on the beat.
 *
 * This matters because the two sensors need different corrections. Sound has to travel
 * INTO the device before the microphone hears it; a wrist does not. Applying the
 * microphone's round trip to a pad hit over-subtracted by 215 ms on the real tablet.
 */
async function measureMotionDelay () {
  if (!motion || !motion.available) return

  /*
   * Skip it once the answer has settled.
   *
   * The tablet, the stand and the pad do not change between sessions, so neither does
   * this number — and after several measurements the running median is steadier than
   * any single day's five taps. Re-measuring daily then costs her twenty seconds of the
   * five minutes and buys nothing.
   *
   * Still re-taken every fifth session, so a genuinely different setup works its way in
   * rather than being locked out forever.
   */
  const settled = padDelayHistory()
  if (settled.length >= 5 && settled.length % 5 !== 0) {
    motionDelayS = medianOf(settled)
    padDelayHistoryMs = settled.map((v) => Math.round(v * 1000))
    applyMotionTiming()
    if (debug) console.log('[drum-buddy] pad delay settled at', Math.round(motionDelayS * 1000), 'ms; skipping taps')
    return
  }
  const dots = $('warmup-dots')
  const target = $('tap-target')
  const label = $('tap-target-label')
  dots.innerHTML = ''
  const TAPS = 5
  for (let i = 0; i < TAPS; i++) dots.append(document.createElement('span'))
  $('warmup-msg').textContent = 'Tap the circle — firmly!'

  motion.setSensitive(true)
  const taps = []
  const spikes = []
  const offMotion = onHits((hit) => {
    if (hit.source === 'motion') spikes.push(hit.onsetTime ?? hit.time)
  })

  target.hidden = false
  for (let i = 0; i < TAPS; i++) {
    label.textContent = `${i + 1} / ${TAPS}`
    target.disabled = false
    const t = await waitForTap(target)
    if (t === null) break
    taps.push(t)
    dots.children[i].classList.add('got')
    target.disabled = true
    // A clear gap before the next one, so a faint jolt can never be attributed to the
    // tap that follows it.
    await sleep(700)
  }
  target.hidden = true
  await sleep(300)                        // let the last jolt arrive
  offMotion()
  motion.setSensitive(false)

  /*
   * Pair each tap with the first jolt that follows it — and only if that jolt is
   * comfortably before the next tap, so a mis-pairing cannot masquerade as a delay.
   */
  const deltas = []
  for (let i = 0; i < taps.length; i++) {
    const t = taps[i]
    const nextTap = taps[i + 1] ?? Infinity
    const after = spikes
      .filter((sp) => sp >= t - 0.03 && sp <= Math.min(t + 0.30, nextTap - 0.1))
      .sort((a, b) => a - b)
    if (after.length) deltas.push(after[0] - t)
  }
  tapDeltasMs = deltas.map((v) => Math.round(v * 1000))
  if (deltas.length >= 3) {
    const sorted = [...deltas].sort((a, b) => a - b)
    const med = sorted[sorted.length >> 1]
    const mad = sorted.map((v) => Math.abs(v - med)).sort((a, b) => a - b)[sorted.length >> 1]
    const kept = sorted.filter((v) => Math.abs(v - med) <= Math.max(mad * 3, 0.03))
    const useMed = kept.length ? kept[kept.length >> 1] : med
    tapSpreadMs = Math.round(mad * 1.4826 * 1000)
    tapKept = kept.length
    /*
     * A reading outside what a 50 Hz sensor can physically do is a broken measurement,
     * not a slow tablet. Keep the physical estimate rather than let it through.
     */
    if (useMed * 1000 > MOTION.padDelayMaxMs) {
      motionDelayS = MOTION.padDelayFallbackMs / 1000
      padDelayRefused = Math.round(useMed * 1000)
      if (debug) console.warn('[drum-buddy] pad delay', padDelayRefused, 'ms is not physically possible; using', MOTION.padDelayFallbackMs)
    } else {
      padDelayRefused = null
      motionDelayS = rememberPadDelay(Math.max(0, useMed))
    }
  } else if (debug) {
    console.warn('[drum-buddy] only', deltas.length, 'usable taps; keeping the stored delay')
  }
  applyMotionTiming()
  dots.innerHTML = ''
}

/** One tap on the target, or null if she gives up waiting. */
function waitForTap (target) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { target.onpointerdown = null; resolve(null) }, 15000)
    target.onpointerdown = (e) => {
      clearTimeout(timer)
      target.onpointerdown = null
      /*
       * Stamped on the RAW context timeline, the same one the accelerometer is stamped
       * on — so the difference between them is the sensor's delay and nothing else.
       *
       * It used to be mapped through clockOffset, which has the output latency folded
       * into it because that is what animation needs. That made every measured "pad
       * delay" come out as (sensor delay + output latency), and applyMotionTiming then
       * added the output latency on top of it a second time. On her tablet that meant
       * subtracting 356 ms where 185 ms was right: she had to hit 171 ms after the
       * sound to be told she was on the beat, which is exactly what it felt like.
       *
       * The event's own timestamp, not the clock read when the handler happens to run.
       */
      resolve(engine.contextTimeFor(e.timeStamp))
    }
  })
}

let motionDelayS = 0
let tapDeltasMs = []
let tapSpreadMs = null
let tapKept = 0

/**
 * Fold today's tap measurement into what previous sessions found.
 *
 * Five taps is not many, and it showed: 214, 184, 134, 190 ms across four sessions, all
 * measuring the same unchanging hardware, averaging about right but wobbling +/-50 ms.
 * Left alone that means a good run today can score differently tomorrow for no reason
 * she did anything to cause.
 *
 * The tablet and the pad do not change between sessions, so neither should this. A
 * median across the last several keeps it steady while still letting a genuine change —
 * a different stand, a different surface — work its way in after a few runs.
 */
/*
 * Versioned, and it was missing entirely.
 *
 * The name was used to read and write localStorage and defined nowhere, so both calls
 * threw ReferenceError into a bare catch and the history was silently always exactly
 * one session long — which is what the diagnostics kept showing and what the median
 * across sessions was supposed to prevent.
 *
 * The suffix is the meaning of the stored number, not the app version: v2 values are
 * the sensor's delay alone, where v1 values had the output latency inside them. Reading
 * one as the other is the bug this whole change is about, so they must not mix.
 */
const PAD_DELAY_KEY = 'drum-buddy:pad-delay:v2'

function padDelayHistory () {
  try {
    const raw = localStorage.getItem(PAD_DELAY_KEY)
    const v = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v.filter((x) => typeof x === 'number') : []
  } catch { return [] }
}

const medianOf = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[s.length >> 1]
}

function rememberPadDelay (measuredS) {
  const history = padDelayHistory()

  history.push(measuredS)
  if (history.length > 7) history.shift()
  try { localStorage.setItem(PAD_DELAY_KEY, JSON.stringify(history)) } catch {}

  const median = medianOf(history)
  if (debug) {
    console.log('[drum-buddy] pad delay: today', Math.round(measuredS * 1000),
      'ms, using', Math.round(median * 1000), 'ms from', history.length, 'sessions')
  }
  padDelayHistoryMs = history.map((v) => Math.round(v * 1000))
  return median
}

/** No measurement today: the sensor's delay is a constant of this hardware. */
function useDefaultPadDelay () {
  const stored = padDelayHistory()
  motionDelayS = stored.length ? medianOf(stored) : MOTION.padDelayFallbackMs / 1000
  padDelayHistoryMs = stored.map((v) => Math.round(v * 1000))
  applyMotionTiming()
}

let padDelayHistoryMs = []
let padDelayRefused = null

/**
 * Tell the timing model what to subtract from a pad hit: how late she HEARS the beat,
 * plus how late the sensor reports it.
 */
function applyMotionTiming () {
  let out = engine.outputLatency || 0
  /*
   * Android often reports this as zero. Falling back to half the microphone's round
   * trip is crude — it assumes sound takes about as long to get out as to get back in —
   * but checked against a real session it lands within 7 ms of the value her playing
   * actually needed, where using the whole round trip was 215 ms out. A guess this
   * close is only a stopgap: once the microphone can hear her hits, the offset between
   * the two sensors is measured directly and neither half has to be guessed at.
   */
  if (out < 0.05 && timing.latencyS) out = timing.latencyS * 0.5
  timing.setMotionTiming({ outputLatencyS: out, motionDelayS })
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

// --------------------------------------------------------------- session

/**
 * Today's five minutes.
 *
 * The same four steps every day — warm up, work on one thing twice, finish on something
 * she can already play — because that is how a teacher structures a beginner's practice
 * and because the ritual is worth something in itself. What changes is which exercise
 * sits in the middle, and how fast; see practice-plan.js for why that moves so slowly.
 *
 * Shown before she starts so she can see the whole thing is short. "Five minutes and
 * you're done" is a much easier ask than an open-ended session.
 */
function showToday () {
  state.plan = buildPlan(history.load())
  state.stepIndex = 0
  state.sessionStars = 0
  state.sessionScores = []

  renderWeek($('today-streak'))

  renderPlan()
  show('today')
  armDrumToStart()
}

/**
 * This week, as dots.
 *
 * Weekly rather than a daily streak: she has a lesson one day a week and will miss
 * others, and a run that breaks on the first missed day would break constantly and
 * punish her for an ordinary week. Four days out of seven is a target a real routine
 * can hit, and the current week never breaks the run — it is not finished yet.
 */
function renderWeek (el) {
  const w = history.weeks(WEEK.goalDays)
  el.innerHTML = ''

  const dots = document.createElement('span')
  dots.className = 'weekdots'
  w.pattern.forEach((d, i) => {
    const dot = document.createElement('i')
    if (d.done) dot.className = 'on'
    else if (d.today) dot.className = 'today'
    else if (d.future) dot.className = 'ahead'
    dot.textContent = WEEK.labels[(i + 1) % 7]
    dots.append(dot)
  })

  const text = document.createElement('span')
  if (w.weekStreak > 1) text.textContent = `🔥 ${w.weekStreak} good weeks in a row!`
  else if (w.goalMet) text.textContent = '🔥 Goal reached this week!'
  else if (w.totalDays === 0) text.textContent = 'Your first practice!'
  else text.textContent = `${w.thisWeekDays} of ${w.goalDays} days this week`

  el.append(dots, text)
  el.setAttribute('aria-label', text.textContent)
}

function renderPlan () {
  const ol = $('today-plan')
  ol.innerHTML = ''
  state.plan.steps.forEach((step, i) => {
    const ex = byId(step.id)
    const li = document.createElement('li')
    if (i < state.stepIndex) li.classList.add('done')
    if (i === state.stepIndex) li.classList.add('now')
    li.innerHTML = '<span class="n"></span><span><span class="what"></span><br><span class="how"></span></span>'
    li.querySelector('.n').textContent = i < state.stepIndex ? '✓' : String(i + 1)
    li.querySelector('.what').textContent = `${step.label}: ${ex.name}`
    li.querySelector('.how').textContent = `${step.bars} bars at ${step.bpm} BPM`
    ol.append(li)
  })
}

/**
 * Lay out the progress bar for today's session: one segment per step, weighted by how
 * long that step actually takes, so the bar measures time rather than steps.
 */
function buildProgress () {
  const host = $('progress')
  host.innerHTML = ''
  if (!state.plan) return
  for (const step of state.plan.steps) {
    const ex = byId(step.id)
    const seconds = (step.bars * ex.beatsPerBar + SCHEDULER.countInBeats) * (60 / step.bpm)
    const seg = document.createElement('i')
    seg.style.setProperty('--w', seconds.toFixed(1))
    host.append(seg)
  }
}

/** @param {number} fraction how far through the current step, 0..1 */
function updateProgress (fraction) {
  const host = $('progress')
  const segs = [...host.children]
  segs.forEach((seg, i) => {
    const fill = i < state.stepIndex ? 1 : i === state.stepIndex ? Math.max(0, Math.min(1, fraction)) : 0
    seg.style.setProperty('--fill', fill.toFixed(3))
    seg.classList.toggle('now', i === state.stepIndex)
  })
}

function runStep () {
  const step = state.plan.steps[state.stepIndex]
  if (!step) return finishSession()
  startExercise(EXERCISES.findIndex((e) => e.id === step.id), step)
}

/** A bonus is never part of the plan — it only exists for the days she wants more. */
function runBonus () {
  const step = bonusStep(history.load(), state.plan)
  state.plan.steps.push(step)
  state.stepIndex = state.plan.steps.length - 1
  runStep()
}

function finishSession () {
  show('session')
  confetti($('session-confetti'), 40)

  const best = state.sessionScores.length ? Math.max(...state.sessionScores) : 0
  const stars = Math.min(3, Math.round(state.sessionStars / Math.max(1, state.sessionScores.length)))

  $('session-stars').textContent = '⭐'.repeat(stars) + '☆'.repeat(3 - stars)
  renderWeek($('session-streak'))

  const dl = $('session-stats')
  dl.innerHTML = ''
  const add = (k, v) => {
    const dt = document.createElement('dt'); dt.textContent = k
    const dd = document.createElement('dd'); dd.textContent = v
    dl.append(dt, dd)
  }
  add('Best score', String(best))
  add('Worked on', byId(state.plan.focusId).name)
  $('play-sr').textContent =
    `Practice finished. Best score ${best}. ${streak} days in a row.`
}

$('btn-start-session').addEventListener('click', startSession)

function startSession () {
  disarmToday()
  state.stepIndex = 0
  runStep()
}

/*
 * Start by drumming, so she never has to put the sticks down and reach for the screen.
 *
 * Guarded the same way as drum-to-continue: armed on a delay, and only hits as hard as
 * the way she actually plays count, since room noise trips a bare detection easily. The
 * Start button is always there too — this is an addition, never the only route.
 */
let disarmToday = () => {}

let todayWatch = null
let warmupHits = []

function armDrumToStart () {
  const threshold = deliberateHitThreshold()
  const hint = $('today-hint')
  if (threshold === null) {
    if (hint) hint.textContent = ''
    todayWatch = { threshold: null, samples: state.hitStrengths.length }
    disarmToday = () => {}
    return
  }
  if (hint) hint.textContent = `…or just hit your pad ${DRUM_NAV.hitsNeeded} times`

  let recent = []
  let armed = false
  todayWatch = { threshold: +threshold.toFixed(3), seen: 0, tooSoon: 0, tooSoft: 0, kept: 0, maxRecent: 0, strengths: [], ctxTimes: [] }
  const timer = setTimeout(() => { armed = true }, DRUM_NAV.armDelayMs)
  const off = onHits((hit) => {
    /*
     * Counted at every stage, because "hit your pad three times" not working has three
     * completely different causes that look identical from the outside: no hits
     * arriving at all, hits arriving before the screen arms, or hits arriving and being
     * judged too soft. Guessing between them has cost two rounds of testing.
     */
    todayWatch.seen++
    if (todayWatch.strengths.length < 25 && typeof hit.strength === 'number') {
      todayWatch.strengths.push(+hit.strength.toFixed(2))
    }
    if (!armed) { todayWatch.tooSoon++; return }
    if (typeof hit.strength === 'number' && hit.strength < threshold) { todayWatch.tooSoft++; return }
    todayWatch.kept++
    /*
     * performance.now(), not the hit's AudioContext time.
     *
     * Twelve hits were accepted here and the window never filled, which can only mean
     * consecutive hits looked more than a second and a half apart — or that subtracting
     * them produced something that is not a number, since NaN < withinMs is false and
     * quietly empties the list on every hit. Both are properties of the measurement
     * clock, and this is not a measurement. Whether she hit the pad three times just now
     * is a question about wall time, so it uses the wall clock, and the invariant this
     * codebase runs on says exactly that: AudioContext time for anything scored,
     * performance.now() for everything else.
     */
    const now = performance.now()
    recent = recent.filter((t) => now - t < DRUM_NAV.withinMs)
    recent.push(now)
    todayWatch.maxRecent = Math.max(todayWatch.maxRecent || 0, recent.length)
    // Kept so the next run can show what the old clock would have done.
    if (todayWatch.ctxTimes.length < 12) todayWatch.ctxTimes.push(+(hit.time * 1000).toFixed(1))
    if (recent.length >= DRUM_NAV.hitsNeeded) startSession()
  })
  disarmToday = () => { clearTimeout(timer); off(); disarmToday = () => {} }
}
$('btn-today-back').addEventListener('click', () => { disarmToday(); abortToStart() })
$('btn-bonus').addEventListener('click', runBonus)
$('btn-session-done').addEventListener('click', () => abortToStart())

// ------------------------------------------------------------------ play

let offHits = null

function startExercise (index, step = null) {
  // Always tear down first. Without this a second call while one is running leaves the
  // old hit listener subscribed, and every hit gets recorded twice — which shows up as
  // a pile of phantom "extra hits" rather than as an obvious crash.
  stopPlay()

  // A plan step overrides length and tempo: the warm-up is short and slow, the focus is
  // longer, and the tempo is whatever she has earned on that exercise.
  const base = EXERCISES[index] || EXERCISES[0]
  const ex = step ? { ...base, bars: step.bars } : base
  state.step = step
  if (step) state.bpm = step.bpm
  state.exerciseIndex = index
  state.hits = []
  state.notes = []
  state.detections = []
  state.motionTrace = []

  show('play')
  $('ex-name').textContent = ex.name
  $('ex-step').textContent = step && state.plan
    ? `${Math.min(state.stepIndex + 1, state.plan.steps.length)}/${state.plan.steps.length} · ${step.label}`
    : ''
  $('ex-tip').textContent = ex.tip
  $('bpm-readout').textContent = state.bpm
  $('play-sr').textContent =
    `${ex.name}. ${ex.blurb} ${ex.tip} Count: ${ex.count}. Tempo ${state.bpm} beats per minute.`

  deafnessHandled = false
  loudSince = 0
  $('streak').innerHTML = '<b>0</b> in a row'

  const beatS = 60 / state.bpm
  state.scorer = new LiveScorer(beatS)

  scheduler.onClick((beat) => {
    // Tell the timing model when we asked for this click; the microphone will report
    // when it actually came back, and the gap keeps K current.
    timing.expectClick(beat.emitAt ?? beat.time)

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
    const corrected = { ...hit, time: timing.correct(hit.time, hit.source) }
    state.hits.push(corrected)
    lastHitAt = hit.time
    if (diagnosticsActive) {
      state.detections.push({
        t: +hit.time.toFixed(4),
        strength: hit.strength,
        bands: hit.bands,
        levels: hit.levels ? hit.levels.map((v) => +v.toFixed(6)) : null,
        source: hit.source,
        corroborated: !!hit.corroborated,
      })
    }
    if (typeof hit.strength === 'number') {
      state.hitStrengths.push(hit.strength)
      if (state.hitStrengths.length > 120) state.hitStrengths.shift()
    }
    if (autoTune && hit.levels) autoTune.sampleHit(hit.levels)
    // Once both sensors have seen enough of the same strikes, the pad's correction can
    // be derived exactly instead of estimated. See TimingModel.latencyFor().
    if (input && input.crossCalibrated) timing.setCrossOffset(input.motionOffsetS)

    /*
     * Always give her feedback.
     *
     * This used to refuse to grade until the latency was certified, on the theory that
     * a wrong number is worse than none. In practice it was far worse than that: every
     * hit was dropped before it reached the scorer, so she drummed into a screen that
     * never responded — while the end-of-exercise summary still read the raw hit list
     * and cheerfully reported "32 of 32". Silence looks like the app is broken, and it
     * hides the fact that detection was working perfectly the whole time.
     *
     * The latency is now always set to SOMETHING — a live measurement when there is one,
     * otherwise the value measured last session or the browser's own estimate — and
     * anything approximate is labelled rather than hidden.
     */
    const res = state.scorer.feed(corrected)
    if (!res) return
    visuals.flashPad(res.note.hand, res.kind)
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

  if (state.step) {
    buildProgress()
    clearInterval(progressTimer)
    const totalS = scheduler.totalBeats * beatS
    progressTimer = setInterval(() => {
      if (!scheduler.running) return
      updateProgress((engine.audibleNow() - scheduler.startTime) / totalS)
    }, 100)
  }

  // The lanes need every note up front so they can fall into view ahead of time; the
  // scheduler works the whole exercise out when it starts.
  // Speaker test: thump instead of tick, and say so on screen so a run cannot be
  // mistaken for a practice.
  scheduler.thumpMode = speakerTest
  if (speakerTest) $('ex-name').textContent = 'SPEAKER TEST — do not play'

  visuals.beatS = beatS
  visuals.setup(ex, scheduler.noteQueue)
  visuals.start(() => engine.audibleNow())

  // Make sure there is always a usable latency before the first note. A live
  // measurement is best, last session's is good, the browser's estimate is a poor third
  // — but any of them beats leaving her without feedback.
  ensureLatency()
  applyMotionTiming()
  /*
   * There used to be a warning here when the timing was "approximate".
   *
   * Approximate now means every session — the microphone no longer measures anything —
   * so it would have appeared before every exercise, and it would have been wrong:
   * output latency plus a known sensor delay is a good number, not a rough guess. A
   * warning that shows up every time teaches her to look past it, which costs more than
   * it ever saved.
   */
}

function updateStreak () {
  $('streak').innerHTML = `<b>${state.scorer.streak}</b> in a row`
}

$('btn-quit').addEventListener('click', () => abortToStart())
$('btn-slower').addEventListener('click', () => nudgeTempo(-TEMPO.step))
$('btn-faster').addEventListener('click', () => nudgeTempo(TEMPO.step))

function nudgeTempo (d) {
  state.bpm = Math.min(TEMPO.max, Math.max(TEMPO.min, state.bpm + d))
  $('bpm-readout').textContent = state.bpm
  if (scheduler.running) { stopPlay(); startExercise(state.exerciseIndex) }
}

let progressTimer = null

function stopPlay () {
  clearInterval(progressTimer)
  inSilentWindow = false
  scheduler.stop()
  visuals.stop()
  if (offHits) { offHits(); offHits = null }
}

function abortToStart () {
  clearTimeout(stepTimer)
  state.step = null
  stopPlay()
  letSleep()
  show('start')
  $('btn-play').disabled = false
}

// ------------------------------------------------------------------ done

function finishExercise () {
  stopPlay()
  storeLatency()
  applyAutoTune()
  uploadSession()
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
  } else if (stats.farOff) {
    // Steady, but nowhere near the beat. Half a beat out is too far to match a note and
    // not far enough to be a whole-beat shift, so without this she gets a blank
    // scoreboard and no idea what happened — which reads as a broken app, not feedback.
    $('done-title').textContent = 'Nearly!'
    $('done-badge').textContent = stats.farOff.direction === 'late'
      ? '🐢 A bit late — try to hit right when you hear the beep!'
      : '🐰 A bit early — wait for the beep!'
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
  /*
   * Creeping faster is the classic beginner fault and it is invisible from inside the
   * playing — she cannot hear a slope, only the app can. Said as a thing that happened
   * over the run, not as a mark against her: the lean above is who she was today, this
   * is what changed while she played.
   */
  if (stats.enough && stats.drifting) {
    add('As you played', stats.drifting === 'faster'
      ? 'you sped up 🐰 — try to hold it steady'
      : 'you slowed down 🐢 — try to hold it steady')
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

  if (state.step) {
    // Mid-session: the result is a moment, not a destination. Keep the momentum.
    state.sessionStars += stats.stars || 0
    if (score !== null) state.sessionScores.push(score)
    $('done-hint').textContent = 'Next in a moment…'
    $('btn-next').textContent = 'Next →'
    clearTimeout(stepTimer)
    stepTimer = setTimeout(advanceStep, 4500)
    return
  }

  armDrumToContinue()
}

let stepTimer = null

function advanceStep () {
  clearTimeout(stepTimer)
  disarm()
  state.stepIndex++
  if (state.stepIndex >= state.plan.steps.length) finishSession()
  else runStep()
}

/**
 * Send the whole take to the developer machine: the beat grid, every detection with its
 * features, the accelerometer trace, and the raw audio.
 *
 * Only ever when that machine is the one serving the page. This exists because
 * aggregates were not enough — they said detection "looked poor" without saying why,
 * and every conclusion drawn from them needed correcting afterwards.
 */
async function uploadSession () {
  if (!diagnosticsActive) return
  const id = new Date().toISOString().replace(/[:.]/g, '-')
  let wav = null
  let audioStartFrame = null
  try {
    const dump = mic ? await mic.dumpAudio() : null
    if (dump) {
      wav = wavFromFloat(dump.pcm, dump.sampleRate)
      audioStartFrame = dump.startFrame
    }
  } catch { /* recording is a nicety, not a requirement */ }

  sendSession({
    id,
    exercise: EXERCISES[state.exerciseIndex]?.id,
    bpm: state.bpm,
    sampleRate: engine.sampleRate,
    latencyMs: timing.latencyMs,
    latencySpreadMs: timing.spreadMs,
    latencyApproximate: !!timing.approximate,
    // Everything below shares the AudioContext clock, so it can all be lined up.
    audioStartFrame,
    notes: state.notes.map((n) => ({ t: +n.time.toFixed(4), hand: n.hand })),
    detections: state.detections,
    motion: state.motionTrace,
    stats: state.lastStats,
    tuning: autoTune ? autoTune.report : null,
    snapshot: snapshot(),
  }, wav)
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

$('btn-again').addEventListener('click', () => {
  clearTimeout(stepTimer)
  disarm()
  startExercise(state.exerciseIndex, state.step)
})
$('btn-next').addEventListener('click', () => {
  disarm()
  if (state.step) advanceStep()
  else nextExercise()
})
$('btn-home').addEventListener('click', () => { disarm(); abortToStart() })

function nextExercise () {
  startExercise((state.exerciseIndex + 1) % EXERCISES.length)
}

/**
 * "Hit your pad to keep going." She is holding sticks; making her put them down to tap
 * a screen between every exercise is real friction.
 *
 * Counting bare detections was not enough — it fired on room noise repeatedly and
 * skipped her ahead on its own. Detections are cheap; DELIBERATE ones are not. So a hit
 * only counts if it is as hard as the way she actually plays, measured from this
 * session rather than from a guess. Until there are enough of her hits to know that,
 * the shortcut stays off entirely and the buttons do the work.
 */
let disarm = () => {}

/** A quarter of her hits are softer than this, so noise almost never reaches it. */
function deliberateHitThreshold () {
  const xs = state.hitStrengths
  /*
   * Four, because four is what the warm-up produces.
   *
   * This wanted eight, and the warm-up asks for four hits and then moves on — so on the
   * Today screen, the one screen where drumming to start is the whole point, the
   * threshold was always null and the option never appeared. It has been asked for
   * repeatedly and was silently disabled by an off-by-one-ritual.
   *
   * Four samples is enough for what this does: the bar is the quietest quarter of her
   * OWN hits, and the gesture still needs three of them inside a second and a half.
   */
  if (xs.length < 4) return null
  const sorted = [...xs].sort((a, b) => a - b)
  /*
   * Six tenths of her quietest quarter, not the quarter itself.
   *
   * The warm-up says "hit your pad four times", which invites firm hits; carrying on to
   * the next thing is a casual tap. Setting the bar at the warm-up's own level asks her
   * to be as emphatic as she was when told to be. The gesture is already specific in
   * time — three hits inside a second and a half — and that is what stops a stray jolt,
   * not the loudness.
   */
  return sorted[Math.floor(sorted.length * 0.25)] * 0.6
}

function armDrumToContinue () {
  const threshold = deliberateHitThreshold()
  const hint = $('done-hint')
  if (threshold === null) {
    if (hint) hint.textContent = ''
    disarm = () => {}
    return
  }
  if (hint) hint.textContent = `Hit your pad ${DRUM_NAV.hitsNeeded} times to keep going`

  let recent = []
  let armed = false
  const timer = setTimeout(() => { armed = true }, DRUM_NAV.armDelayMs)

  const off = onHits((hit) => {
    if (!armed) return
    if (typeof hit.strength === 'number' && hit.strength < threshold) return
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

// ---------------------------------------------------------------- players

/**
 * Progress is personal, so scores and level are stored per player. The measured latency
 * and the pad's sensor delay are not — they describe this tablet on this pad, and
 * everyone who plays here shares them.
 */
function renderPlayerChip () {
  const p = players.current()
  $('player-emoji').textContent = p.emoji
  $('player-name').textContent = p.name
  $('player-chip').setAttribute('aria-label', `Playing as ${p.name}. Tap to change.`)
}

function showPlayers () {
  const grid = $('player-grid')
  grid.innerHTML = ''
  const now = players.current()
  for (const p of [...players.list(), players.GUEST]) {
    const b = document.createElement('button')
    b.type = 'button'
    b.setAttribute('aria-pressed', String(p.id === now.id))
    b.innerHTML = '<span class="face"></span><span class="who"></span>'
    b.querySelector('.face').textContent = p.emoji
    b.querySelector('.who').textContent = p.name
    if (p.guest) {
      const sub = document.createElement('span')
      sub.className = 'sub'
      sub.textContent = 'nothing saved to her'
      b.append(sub)
    }
    b.addEventListener('click', () => {
      players.setCurrent(p.id)
      loadLevel()
      renderPlayerChip()
      show('start')
    })
    grid.append(b)
  }
  show('players')
}

function showNewPlayer () {
  let chosen = players.AVATARS[0]
  const grid = $('avatar-grid')
  grid.innerHTML = ''
  for (const emoji of players.AVATARS) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = emoji
    b.setAttribute('aria-label', 'Choose ' + emoji)
    b.setAttribute('aria-pressed', String(emoji === chosen))
    b.addEventListener('click', () => {
      chosen = emoji
      for (const other of grid.children) other.setAttribute('aria-pressed', String(other === b))
    })
    grid.append(b)
  }
  $('newp-name').value = ''
  show('new-player')
  setTimeout(() => $('newp-name').focus(), 100)

  $('btn-save-player').onclick = () => {
    players.create($('newp-name').value, chosen)
    loadLevel()
    renderPlayerChip()
    show('start')
  }
  $('btn-cancel-player').onclick = () => showPlayers()
}

$('player-chip').addEventListener('click', showPlayers)
$('btn-new-player').addEventListener('click', showNewPlayer)
$('btn-players-back').addEventListener('click', () => show('start'))
renderPlayerChip()

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
    const id = localStorage.getItem(players.key(LEVEL_STORAGE_KEY))
    autoLevel = id === null || id === 'auto'
    const found = LEVELS.find((l) => l.id === id)
    if (found) level = found
    if (autoLevel) {
      const savedAuto = LEVELS.find((l) => l.id === localStorage.getItem(players.key(LEVEL_STORAGE_KEY + '.auto')))
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
  // Hidden in normal use — see the note in index.html. Still rendered under ?debug so a
  // level can be pinned while testing.
  host.hidden = !debug
  if (!debug) return
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
      try { localStorage.setItem(players.key(LEVEL_STORAGE_KEY), l.id) } catch {}
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

function goFullscreen () {
  if (document.fullscreenElement) { fullscreenNote = 'already'; return }
  if (installed) { fullscreenNote = 'installed'; return }
  if (!document.documentElement.requestFullscreen) { fullscreenNote = 'unsupported'; return }
  // Not awaited by the caller: cosmetic, and nothing should block on it. The reason for
  // a refusal is recorded rather than swallowed — "it doesn't work" was reported with
  // no way to see why.
  fullscreenNote = 'requested'
  // No options: navigationUI is advisory and some builds appear to choke on it.
  const req = document.documentElement.requestFullscreen()
  if (req && req.then) {
    req.then(() => { fullscreenNote = 'granted' })
      .catch((err) => { fullscreenNote = 'refused: ' + (err && err.name) })
  }
  // The promise has been seen never to settle at all, so check the actual outcome too.
  setTimeout(() => {
    if (fullscreenNote === 'requested') {
      fullscreenNote = document.fullscreenElement ? 'granted (silent)' : 'ignored'
      if (!document.fullscreenElement) armFullscreenRetry()
    }
  }, 1200)
}

/**
 * Try again on the next touch anywhere.
 *
 * On the real tablet the request from the Play button neither resolves nor rejects — the
 * browser simply drops it, which it does when a permission prompt is in flight, and the
 * microphone is being asked for at that exact moment. A later tap is an unambiguous
 * fresh gesture with nothing else competing for it. One shot, then it stops asking.
 */
let retryArmed = false
function armFullscreenRetry () {
  if (retryArmed || installed) return
  retryArmed = true
  const go = () => {
    document.removeEventListener('pointerdown', go)
    if (document.fullscreenElement) return
    try {
      const r = document.documentElement.requestFullscreen()
      fullscreenNote = 'retried'
      if (r && r.then) {
        r.then(() => { fullscreenNote = 'granted (retry)' })
          .catch((err) => {
            // The name alone has been 'TypeError' twice with no way to tell which of
            // Chrome's several TypeErrors it is. The message says which.
            fullscreenNote = 'retry refused: ' + (err && err.name) + ': ' + (err && err.message)
          })
      }
    } catch (err) {
      fullscreenNote = 'retry threw: ' + (err && err.name)
    }
  }
  document.addEventListener('pointerdown', go)
}

let fullscreenNote = 'not tried'

/**
 * Manual toggle, for getting back out or for a browser that refused the automatic
 * request. Hidden when it can't work (iOS Safari won't full-screen a document) or when
 * it's pointless (already installed and running full screen).
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
      if (document.fullscreenElement) { await document.exitFullscreen(); fullscreenNote = 'exited' }
      else { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); fullscreenNote = 'granted' }
    } catch (err) {
      fullscreenNote = 'refused: ' + (err && err.name)
      toast('This browser wouldn’t go full screen', 3000)
    }
  })
  document.addEventListener('fullscreenchange', sync)
  sync()
}


/**
 * Everything worth knowing about how detection is going, in one object.
 *
 * Read remotely while the app runs on the real tablet, so behaviour can be diagnosed
 * from the device itself rather than inferred from a description of what happened on
 * screen — which mis-diagnosed three separate bugs here.
 */
function snapshot () {
  const hs = [...state.hitStrengths].sort((a, b) => a - b)
  const q = (f) => (hs.length ? hs[Math.floor((hs.length - 1) * f)] : null)
  return {
    when: new Date().toISOString(),
    // The real numbers, so layout can be checked against the device she uses rather
    // than against a guess at what an old tablet is.
    viewport: {
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: window.devicePixelRatio,
      orientation: window.innerWidth >= window.innerHeight ? 'landscape' : 'portrait',
      fullscreen: !!document.fullscreenElement ||
        window.matchMedia('(display-mode: fullscreen)').matches,
      overflowing: (() => {
        const on = document.querySelector('.screen.on')
        if (!on) return []
        return [...on.querySelectorAll('*')]
          .filter((el) => {
            const r = el.getBoundingClientRect()
            return r.height > 0 && (r.bottom > window.innerHeight + 1 || r.top < -1 ||
              r.right > window.innerWidth + 1 || r.left < -1)
          })
          .map((el) => (el.id || el.className || el.tagName).toString().slice(0, 30))
          .slice(0, 6)
      })(),
    },
    screen: [...document.querySelectorAll('.screen')].find((x) => x.classList.contains('on'))?.id,
    sensors: {
      timingFrom: input ? input.timingSource : 'none',
      micAvailable: !!(mic && mic.available),
      micError: mic ? mic.error : null,
      micProcessing: mic ? mic.processing : null,
      motionAvailable: !!(motion && motion.available),
      motionError: motion ? motion.error : null,
      motionRateHz: motion ? motion.rateHz : null,
      motionRest: motion ? motion.rest : null,
      corroboration: input ? input.corroborationRate : null,
      micReceiving: mic ? mic.receiving : null,
      micMuted: mic ? mic.muted : null,
      micPermission: mic ? mic.permission : null,
      micTrackState: mic && mic.track ? mic.track.readyState : null,
      micConstraints: mic ? mic.constraintsUsed : null,
      motionOffsetMs: input && input.motionOffsetS ? Math.round(input.motionOffsetS * 1000) : 0,
      motionDelayMs: Math.round(motionDelayS * 1000),
      tapDeltasMs,
      tapSpreadMs,
      tapKept,
      padDelayHistoryMs,
      outputLatencyMs: Math.round((engine.outputLatency || 0) * 1000),
      timestampTrusted: engine._timestampUsable,
      fullscreen: fullscreenNote,
      // Chrome rejects with a bare TypeError both when the gesture is stale and when
      // the document may not go full screen at all. This separates the two.
      fullscreenAllowed: document.fullscreenEnabled,
      installedMode: installed,
      ua: navigator.userAgent.slice(0, 120),
      screen: `${screen.width}x${screen.height}`,
      outerWindow: `${window.outerWidth}x${window.outerHeight}`,
      standalone: window.matchMedia('(display-mode: standalone)').matches,
      visualLagMs: engine.visualLagMs,
      // How far apart ctx.currentTime's steps are. Anything much above a couple of
      // milliseconds means motion timing has to go through engine.nowFine.
      clockStepMs: engine.clockStepMs ? Math.round(engine.clockStepMs) : null,
      padDelayRefused,
      todayWatch,
      warmupHits,
      trackLatencyMs: mic && mic.stream
        ? Math.round(((mic.stream.getAudioTracks()[0].getSettings() || {}).latency || 0) * 1000)
        : null,
      sampleRate: engine.sampleRate,
    },
    timing: {
      status: timing.status,
      latencyMs: timing.latencyMs,
      spreadMs: timing.spreadMs,
      approximate: !!timing.approximate,
      usable: timing.usable,
      appliedToMotionMs: Math.round(timing.latencyFor('motion') * 1000),
      appliedToMicMs: Math.round(timing.latencyFor('mic') * 1000),
    },
    detection: {
      hits: state.hits.length,
      notes: state.notes.length,
      hitStrength: { p10: q(0.1), p50: q(0.5), p90: q(0.9), n: hs.length },
      micPeak: mic ? mic.level : null,
    },
    tuning: autoTune ? autoTune.report : null,
    lastStats: state.lastStats,
    exercise: EXERCISES[state.exerciseIndex]?.id,
    bpm: state.bpm,
    level: level.id,
    // Anything that blew up, so a silent failure on the tablet is not invisible.
    errors: runtimeErrors,
      }
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
    snapshot,
  }


  console.log('[drum-buddy] debug on — window.drumBuddy')
}

/*
 * When the app is being served from a developer machine on the same network, post what
 * it is seeing back there. Does nothing at all in the published build.
 */
/*
 * Offer to install, which is the only dependable route to an immersive window on
 * Android. The Fullscreen API reported success on the tablet and still left the tab
 * strip, status bar and navigation bar showing; an installed app has none of them.
 *
 * Chrome decides when to offer this and hands us the prompt; we stash it and show a
 * button rather than nagging on load.
 */
let installPrompt = null
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  installPrompt = e
  const btn = $('btn-install')
  if (btn && !installed) btn.hidden = false
})
$('btn-install').addEventListener('click', async () => {
  if (!installPrompt) return
  $('btn-install').hidden = true
  installPrompt.prompt()
  try { await installPrompt.userChoice } catch {}
  installPrompt = null
})
window.addEventListener('appinstalled', () => { $('btn-install').hidden = true })

// The service worker is what makes the install offer possible, and lets her practise
// with no wifi. Not registered on the dev server, where a stale cache would be a
// needless source of confusion.
if ('serviceWorker' in navigator && !diagnosticsActive) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').catch(() => {})
  })
}

/** Anything that blew up, so a silent failure on the tablet is not invisible again. */
const runtimeErrors = []
window.addEventListener('error', (e) => {
  runtimeErrors.push(`${e.message} @ ${e.filename}:${e.lineno}`)
  if (runtimeErrors.length > 10) runtimeErrors.shift()
})
window.addEventListener('unhandledrejection', (e) => {
  runtimeErrors.push('unhandled: ' + ((e.reason && e.reason.message) || e.reason))
  if (runtimeErrors.length > 10) runtimeErrors.shift()
})

startDiagnostics(snapshot)
