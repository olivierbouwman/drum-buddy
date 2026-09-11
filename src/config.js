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
}

export const SCHEDULER = {
  tickMs: 25,           // how often the lookahead loop runs
  lookaheadS: 0.15,     // how far ahead clicks are scheduled
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
  minRateHz: 25,        // below this the sensor is useless even for confirmation
  spikeOverRest: 3.0,   // magnitude ratio that counts as a hit
  refractoryMs: 90,
  timingTrusted: false, // never take the timestamp from this sensor while the mic works
}

export const FUSION = {
  /** Generous, because the accelerometer's own timestamps scatter by ~38 ms. */
  agreeMs: 90,
}

export const CALIBRATION = {
  clicks: 12,
  minGapS: 0.38,
  maxGapS: 0.52,
  discardFirst: 3,
  acceptSpreadMs: 8,     // MAD-derived; above this we don't trust the number
  plausibleMinMs: 15,
  plausibleMaxMs: 400,
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
  refuseIfSpreadAboveMs: 12,
  storageKey: 'drum-practice.latency.v1',
}

/**
 * The jug band. Members wake up as her streak grows, so the reward for playing
 * steadily is more music — which is the whole idea of a jug band.
 *
 * Emoji picked for a riverside-hollow jug band and checked against the Apple emoji
 * font so none render as an empty box. There is no capybara or porcupine in Unicode;
 * beaver and hedgehog are the nearest that actually draw. Rabbit and turtle are
 * reserved — they mean "quick" and "slow", and reusing them would muddle that.
 */
export const BAND = [
  { at: 0,  emoji: '🦦', name: 'Otter',    label: 'Otter on the washtub bass' },
  { at: 4,  emoji: '🦫', name: 'Beaver',   label: 'Beaver picks up the guitar!' },
  { at: 8,  emoji: '🦔', name: 'Hedgehog', label: 'Hedgehog starts on the jug!' },
  { at: 12, emoji: '🐭', name: 'Mouse',    label: 'Mouse grabs the washboard!' },
  { at: 16, emoji: '🐸', name: 'Frog',     label: 'Frog joins in on fiddle!' },
]

/**
 * Steadiness bands, in ms of spread. Names, never grades.
 *
 * Also rescaled: the old top band needed 25 ms of spread, which is trained-musician
 * territory. A normal eight-year-old would have scored the bottom badge every single
 * session forever. Thresholds now come from the chosen level.
 */
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
  withinMs: 1500,
}
