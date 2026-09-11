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

/** How close to the beat counts as what. Generous on purpose — she is eight. */
export const WINDOWS = {
  perfect: 40,   // ms either side
  great: 80,
  almost: 130,
}

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

/** PHASE-0: replace with the bands tools/analyse.mjs recommends for the real pad. */
export const DETECTOR = {
  bands: [2500, 3500, 5000, 7000, 10000, 14000],
  q: 2.5,
  fastTauMs: 1.0,
  slowTauMs: 30,
  triggerOverSlow: 2.0,     // fast must exceed slow by this ratio (+6 dB)
  triggerOverFloor: 4.0,    // ...and the noise floor by this (+12 dB)
  bandsNeeded: 4,           // of 6 — a stick hits every band, speaker distortion hits 2-3
  agreementMs: 1.5,
  maxRiseMs: 4,             // slower attacks are speech, not sticks
  refractoryMs: 70,
  /**
   * Stick bounce rejection. Careful here: the second note of a DOUBLE stroke is a real
   * note and is often quieter than the first, so these thresholds must stay well below
   * the gap between intentional notes. At 60 BPM even eighth notes are 500 ms apart,
   * so 150 ms is safe — revisit if fast sixteenth-note doubles are ever added.
   */
  bounceRejectMs: 150,
  bounceRejectDb: 9,
}

export const MOTION = {
  minRateHz: 25,        // below this the sensor is useless for timing
  spikeOverRest: 3.0,   // magnitude ratio that counts as a hit
  refractoryMs: 90,
}

export const FUSION = {
  agreeMs: 30,          // mic and motion this close = the same hit
}

export const CALIBRATION = {
  clicks: 12,
  minGapS: 0.38,
  maxGapS: 0.52,
  discardFirst: 3,
  acceptSpreadMs: 8,     // MAD-derived; above this we don't trust the number
  plausibleMinMs: 15,
  plausibleMaxMs: 400,
  warnAboveMs: 120,      // probably a Bluetooth speaker
  refuseAboveMs: 250,
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

/** Steadiness bands, in ms of spread. Names, never grades. */
export const STEADINESS = [
  { under: 25,       badge: 'Steady as the river!', stars: 3 },
  { under: 45,       badge: 'Real steady playing!', stars: 3 },
  { under: 70,       badge: 'Getting steadier!',    stars: 2 },
  { under: Infinity, badge: 'Keep on playing!',     stars: 1 },
]

/** Drum-to-continue: deliberate hits only, never an accidental skip. */
export const DRUM_NAV = {
  armDelayMs: 1000,     // ignore hits for this long after a screen appears
  hitsNeeded: 2,
  withinMs: 2500,
}
