/**
 * Every tunable number in the app, in one place.
 *
 * Anything you might want to change after watching her play for ten minutes should be
 * here, not buried in a module. Numbers marked PHASE-0 are placeholders until the real
 * pad has been measured with tools/record.html.
 */

export const TEMPO = {
  min: 40,
  max: 120,
  default: 60,
  step: 5,
}

/**
 * How close to the beat counts as what, in milliseconds either side.
 *
 * Sized from what people can actually do. Tapping along to a metronome, adult
 * non-musicians scatter with a standard deviation of roughly 20-50 ms, eight-year-olds
 * more like 50-80 ms, trained musicians 10-20 ms, professionals 5-15 ms.
 *
 * An earlier ±40 ms "perfect" window meant a typical beginner saw a star on well under
 * half her hits — most of her playing came back as a rabbit or a turtle. Worse, it was
 * not even actionable: the smallest timing difference a person can reliably feel and
 * correct is around 20-30 ms, so anything tighter reports noise she cannot do anything
 * about.
 *
 * At LEARNING level a typical beginner lands a star roughly two thirds of the time,
 * which is the point: often enough to feel good, not so often that improving stops
 * showing up.
 */
export const LEVELS = [
  { id: 'learning', name: 'Just starting',  perfect: 70, great: 110, almost: 165,
    steady: [60, 90, 130] },
  { id: 'getting',  name: 'Getting good',   perfect: 50, great: 85,  almost: 135,
    steady: [42, 65, 95] },
  { id: 'sharp',    name: 'Sharp ears',     perfect: 35, great: 62,  almost: 105,
    steady: [28, 45, 70] },
]

/**
 * How long a session should actually be.
 *
 * Measured rather than assumed: the first version's bar counts came to 2.6 minutes of
 * drumming inside a 4-minute session, which is not the five minutes it claimed. Step
 * lengths are now derived from this target so the label stays true when tempo changes —
 * a faster tempo means the same bars take less time, and the session would quietly
 * shrink.
 *
 * Five minutes means five minutes of DRUMMING, not five minutes of app. Count-ins,
 * results screens and calibration sit on top of this.
 */
export const SESSION = {
  targetPlayingSeconds: 300,
  /** Roughly how the time is shared out; the focus gets the lion's share. */
  weights: { warmup: 0.18, focus: 0.28, finisher: 0.26 },
  minBars: 4,
  maxBars: 34,
}

/**
 * Practice is not expected every day.
 *
 * She has a lesson once a week and will miss days; a streak that breaks on the first
 * missed day would break constantly and punish her for a normal week. So the unit is
 * the WEEK: hit the goal, keep the run going.
 */
export const WEEK = {
  goalDays: 4,
  /** Days of the week are shown as dots so progress is visible without reading. */
  labels: ['S', 'M', 'T', 'W', 'T', 'F', 'S'],
}

export const LEVEL_STORAGE_KEY = 'drum-practice.level.v1'

/** Filled in at start-up from the chosen level; see applyLevel() in main.js. */
export const WINDOWS = { perfect: 70, great: 110, almost: 165 }

export const METRONOME = {
  freqNormal: 900,      // Hz. 800-2000 is where small speakers are efficient and clean.
  freqAccent: 1200,
  durationMs: 30,
  peak: 0.25,           // Hann-windowed sine peak, pre-gain
  /**
   * Hard cap on metronome output. Small speakers distort badly when driven hard, and
   * that distortion lands in the 3-10 kHz band we listen for stick hits in. Capping
   * the level is the cheapest bleed mitigation there is.
   */
  maxGain: 0.25,

  /*
   * Play each click this many milliseconds early.
   *
   * Not a fudge factor, and deliberately NOT a shift of the beat grid or the visuals.
   *
   * The app predicts a click scheduled at time T will be heard at T plus the browser's
   * reported output latency, and it draws the falling note to cross the line at exactly
   * that moment. If the browser under-reports — Android's estimate is a nominal figure,
   * not a measurement — the sound comes out after the line has already crossed, and it
   * feels late. Reported as exactly that on the tablet.
   *
   * Emitting early by the shortfall makes the sound arrive when the app already said it
   * would, which is when the line crosses and when the grid says the beat is. Nothing
   * downstream moves: her hits are still scored against the same grid, so this cannot
   * flatter or punish her playing. It only stops the speaker running behind everything
   * else that is trying to agree with it.
   *
   * Only a FALLBACK. When the device has ever measured its own speaker-to-microphone
   * round trip, the shortfall is derived from that instead — see speakerNudgeS(). A
   * hand-set 30 ms was a guess, and it was less than half of what her tablet needed.
   */
  nudgeMs: 30,
  /*
   * A ceiling, because a derived figure comes from readings nothing re-checks.
   *
   * Raised from 150 once her tablet was tuned by ear to 125 — close enough to the old
   * ceiling that a slightly slower device would have been silently clipped, and a clip
   * here is indistinguishable from a correct answer. Must stay below SCHEDULER.lookaheadS,
   * since the scheduler has to reach a beat before it needs to emit it; there is a test
   * on that relationship.
   */
  nudgeMaxMs: 200,
}

export const SCHEDULER = {
  tickMs: 25,           // how often the lookahead loop runs
  lookaheadS: 0.25,     // how far ahead clicks are scheduled; must exceed METRONOME.nudgeMaxMs
  countInBeats: 4,
}

/**
 * MEASURED on the real pad, sticks, speaker and room (2026-09-10, Android Chrome).
 * See tools/analyse.mjs and tools/tune.mjs; re-run those if the hardware changes.
 *
 * The click sits at 900 Hz and dominates 800 Hz-1 kHz (-41 dBFS). Her softest hits are
 * 22-33 dB above the bleed everywhere from 2.5-10 kHz, so that is where we listen.
 */
export const DETECTOR = {
  bands: [2500, 3150, 4000, 5000, 6300, 8000],
  /**
   * Biquads cascaded per band. NOT cosmetic: one biquad rolls off at only 6 dB/octave,
   * leaving the 900 Hz click barely 13 dB down inside the 2.5 kHz band, and it
   * triggered the detector as readily as a real hit. Measured against take 1 (metronome
   * playing, nobody drumming): 1 stage gave 6 false triggers, 2 gave 0, 3 gave 0 with
   * more margin. An FFT view of the bands looks clean and hides this entirely.
   */
  stages: 3,
  q: 2.5,
  fastTauMs: 1.0,
  slowTauMs: 30,
  triggerOverSlow: 2.0,     // fast must exceed slow by this ratio (+6 dB)
  triggerOverFloor: 4.0,    // ...and the noise floor by this (+12 dB)
  bandsNeeded: 4,           // of 6 — a stick hits every band, speaker distortion hits 2-3
  agreementMs: 1.5,
  /**
   * Slower attacks are speech, not sticks. Loosened from 4 ms: the gate only needs to
   * separate a stick (1-2 ms) from a sibilant (10 ms+), so there is no reason to sit
   * right on top of the thing being measured.
   */
  maxRiseMs: 8,
  /**
   * Fallback only — the real value comes from refractoryForSpacing() in dsp-core.js,
   * derived from the note spacing the exercise actually asks for. Measured: strikes
   * came as close as 88 ms during fast playing, so a fixed 70 ms would let bounce
   * through while a fixed 150 ms would swallow genuinely fast playing.
   */
  refractoryMs: 120,
  /**
   * Stick bounce rejection. Careful here: the second note of a DOUBLE stroke is a real
   * note and is often quieter than the first, so these thresholds must stay well below
   * the gap between intentional notes. At 60 BPM even eighth notes are 500 ms apart,
   * so 150 ms is safe — revisit if fast sixteenth-note doubles are ever added.
   */
  bounceRejectMs: 150,
  bounceRejectDb: 9,
}

/**
 * Accelerometer. MEASURED: it feels hits clearly (21 dB spike-to-rest, 60 Hz), but its
 * TIMESTAMPS scatter by ~38 ms against the microphone — far worse than the 4.8 ms the
 * 60 Hz sample rate implies, because DeviceMotionEvent delivery waits on the main
 * thread. Against her ~50 ms natural scatter that would inflate every reading.
 *
 * So it is a confirmation sensor, not a timing source: it says a hit HAPPENED (immune
 * to metronome bleed and room noise), and the microphone says exactly WHEN.
 */
export const MOTION = {
  /*
   * What a pad delay is allowed to be.
   *
   * This is the gap between the stick touching rubber and the accelerometer sample that
   * shows it — quantisation at ~50 Hz plus however long the browser sits on the event.
   * Tens of milliseconds, physically. It cannot be 185.
   *
   * It was reading 185 because the tap it was compared against had the output latency
   * folded into it, so a measurement of the sensor was really a measurement of the
   * speaker. A ceiling here means that class of mistake shows up as a refused reading
   * instead of quietly becoming her score.
   */
  padDelayMaxMs: 90,
  /*
   * Used every session now, not just when a measurement fails.
   *
   * Half a sample period at ~48 Hz is 10 ms of quantisation on its own, and the browser
   * adds a little on top delivering the event. Every reading her tablet has produced
   * once the clocks were straightened out sat between 5 and 22 ms.
   */
  padDelayFallbackMs: 15,

  minRateHz: 25,        // below this the sensor is useless even for confirmation
  windowS: 3.0,         // how much history the median and spread are taken over
  /**
   * A hit is the median plus this many times the gap up to the 90th percentile.
   * Tuned against a real session on the tablet: k=2 found 26 of her 32 notes with 30 ms
   * of spread, and was insensitive to the floor, which is what robust looks like.
   */
  spikeOverSpread: 2.0,
  minThreshold: 0.3,    // absolute floor, so a perfectly still device isn't twitchy
  /** Used only while measuring the sensor's delay against a screen tap. */
  calibrateOverSpread: 0.6,
  calibrateMinThreshold: 0.06,
  refractoryMs: 120,
  /*
   * The rebound rule.
   *
   * A single strike on her pad logged twice: the second event 167 ms after the first at
   * 22% of its strength, clearing the 120 ms refractory by a comfortable margin and
   * checking off two of the four warm-up dots for one hit. Widening the refractory to
   * cover it would start swallowing real notes, so this discriminates on shape instead:
   * a rebound is both close AND much weaker, and a real stroke is not.
   *
   * The window was 250 ms, set from the single example available at the time. The next
   * run produced two more, at 266 ms and 300 ms, and sailed straight through it — two
   * taps lit all four warm-up dots. So the window is 400 ms.
   *
   * What makes that safe is the ratio, which is the reliable half of this rule: the
   * three rebounds measured so far came in at 22%, 6% and 12% of the strike before them.
   * Nothing that quiet is a note. Tightening the ratio to 0.35 while widening the window
   * leaves real playing further clear than the original pair did — eighth notes at
   * 90 bpm are 333 ms apart, and the second one is not a third the weight of the first.
   *
   * Worth revisiting for ghost notes, where a deliberately quiet stroke follows a loud
   * one on purpose. Not in anything she plays yet.
   */
  reboundMs: 400,
  reboundRatio: 0.35,
  /**
   * The microphone still times a hit when it can: it is sample-accurate and this is
   * not. But measured on the real tablet this sensor reaches 30 ms of spread, which is
   * well inside a beginner's own ~70 ms — so when the microphone delivers nothing, this
   * carries the exercise rather than leaving her with no feedback at all.
   */
  timingTrusted: true,
}

export const FUSION = {
  /** Generous, because the accelerometer's own timestamps scatter by ~38 ms. */
  agreeMs: 90,
}

export const CALIBRATION = {
  clicks: 12,
  /**
   * Calibration clicks must be spaced FURTHER APART than the latency being measured, or
   * a click heard now is ambiguous between the one just played and the one before it.
   * At 0.42 s apart against a 394 ms round trip the measurement was meaningless.
   */
  minGapS: 0.95,
  maxGapS: 1.15,
  discardFirst: 3,
  acceptSpreadMs: 8,     // MAD-derived; above this we don't trust the number
  plausibleMinMs: 15,
  /**
   * Anything slower than this is taken to be a mis-match rather than a measurement.
   *
   * Was 400 ms, which this very tablet had already been measured at 394 ms — sitting on
   * the limit, and once past it EVERY reading was thrown away as implausible and the app
   * never got a latency at all. The bound exists only to catch a click matched to the
   * wrong beat, so it needs to sit below the gap between clicks, not near any real
   * device's latency. Android audio stacks genuinely reach half a second.
   */
  plausibleMaxMs: 900,
  /**
   * MEASURED 353 ms round trip on Android Chrome — with a spread of 0.0 ms across ten
   * clicks. The original plan refused to score above 250 ms on the assumption that a
   * high latency means Bluetooth and therefore a DRIFTING latency. That rule would have
   * locked this device out for no reason: a large constant subtracts just as cleanly as
   * a small one. What actually matters is whether the number holds still, so the refusal
   * is now on instability, not magnitude.
   */
  warnAboveMs: 250,
  refuseAboveMs: 600,
  /**
   * How much the measured latency may wander before it stops being trusted as exact.
   * Loosened from 12 ms: this only decides whether the number is called measured or
   * approximate, and 25 ms is still comfortably inside the 70 ms "perfect" window, so
   * a slightly restless device gets graded rather than ignored.
   */
  refuseIfSpreadAboveMs: 25,
  storageKey: 'drum-practice.latency.v1',
}

/**
 * Steadiness bands, in ms of spread. Names, never grades.
 *
 * Also rescaled: the old top band needed 25 ms of spread, which is trained-musician
 * territory. A normal eight-year-old would have scored the bottom badge every single
 * session forever. Thresholds now come from the chosen level.
 */
/**
 * Speeding up or slowing down across a run, as a fraction of one beat.
 *
 * Scatter and drift are different faults and only one of them was being scored. A real
 * run came back with tight scatter and a slope that added up to an eighth of a beat by
 * the end — the player started on the beat and finished well ahead of it — and the app
 * called that "Real steady playing!" and gave three stars. Creeping faster is the most
 * common beginner fault there is, and it was the one thing the summary could not see.
 *
 * Measured as total accumulated drift over the whole run, because that is what it
 * sounds like: a slope too small to hear in any one bar is obvious over thirty.
 */
export const DRIFT = {
  mentionOverBeat: 0.12,   // say something about it
  costsStarsOverBeat: 0.3, // it is now the biggest thing that went wrong
}

export const STEADINESS = [
  { under: 45,       badge: 'Steady as the river!', stars: 3 },
  { under: 70,       badge: 'Real steady playing!', stars: 3 },
  { under: 100,      badge: 'Getting steadier!',    stars: 2 },
  { under: Infinity, badge: 'Keep on playing!',     stars: 1 },
]

/** Swap in a difficulty level's numbers. Mutates in place so importers see the change. */
export function applyLevel (level) {
  WINDOWS.perfect = level.perfect
  WINDOWS.great = level.great
  WINDOWS.almost = level.almost
  const [a, b, c] = level.steady
  STEADINESS[0].under = a
  STEADINESS[1].under = b
  STEADINESS[2].under = c
}

/**
 * Drum-to-continue: deliberate hits only, never an accidental skip.
 *
 * Two hits inside two and a half seconds turned out to be too easy to hit by accident —
 * the room noise in the Phase 0 recordings alone fired the detector about once a second,
 * which would have skipped her ahead on its own. Three hits close together is a gesture
 * nothing but a person makes.
 */
export const DRUM_NAV = {
  armDelayMs: 2000,     // ignore hits for this long after a screen appears
  hitsNeeded: 3,
  /*
   * Three seconds, because that is how people actually do this.
   *
   * It was 1500 ms, and the instrumentation caught what that meant: ten deliberate hits
   * on the Today screen, every one of them accepted, and the window never held more than
   * TWO at a time. The gaps were 1080, 1022, 1034, 1064, 1049, 1125, 998, 1036, 1034 —
   * someone asked to hit a pad three times does it at about one per second, and three of
   * those span two seconds, not one and a half. The gesture was arithmetically impossible
   * to perform at the pace anyone performs it.
   *
   * Three hits inside three seconds is still far more specific than the two inside 2500 ms
   * that used to fire by accident: it is the COUNT that makes it deliberate, and this
   * asks for one more hit than that version did.
   */
  withinMs: 3000,
}
