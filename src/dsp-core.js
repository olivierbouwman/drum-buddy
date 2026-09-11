/**
 * The onset detector, as pure functions.
 *
 * Deliberately free of AudioWorklet globals so the exact same code can run in the
 * worklet, in the offline analyser against real recordings, and in tests. If the
 * detector that runs in the app is not literally the one that was tuned against the
 * recordings, the tuning means nothing.
 *
 * Approach: a bandpass filterbank with fast and slow envelope followers, which is what
 * hardware drum triggers do. An FFT would impose hop-size time quantisation and half a
 * window of group delay; here the time resolution is the sample rate, and the group
 * delay stays well under a millisecond.
 *
 * Each band is a CASCADE of biquads, not one. This matters more than it looks. A single
 * biquad rolls off at only 6 dB/octave, so the 900 Hz metronome click sat barely 13 dB
 * down inside the 2.5 kHz band and triggered the detector as readily as a real hit —
 * measured on the actual pad, one biquad per band gave 8 false triggers from 10 clicks.
 * Cascading three gets 18 dB/octave and pushes the click far enough down to disappear.
 *
 * The detection function is a RATIO, (fast - slow) / slow, not a difference. That makes
 * it amplitude-normalised, so the iPad's auto-gain (which cannot be turned off) and a
 * child hitting at wildly different volumes both stop mattering.
 */

/** RBJ cookbook bandpass, constant 0 dB peak gain. */
export function bandpassCoeffs (fc, Q, rate) {
  const w0 = (2 * Math.PI * fc) / rate
  const alpha = Math.sin(w0) / (2 * Q)
  const a0 = 1 + alpha
  return {
    b0: alpha / a0,
    b1: 0,
    b2: -alpha / a0,
    a1: (-2 * Math.cos(w0)) / a0,
    a2: (1 - alpha) / a0,
  }
}

/** One-pole smoothing coefficient for a given time constant. */
const poleFor = (tauMs, rate) => Math.exp(-1 / ((tauMs / 1000) * rate))

export class OnsetDetector {
  /**
   * @param {number} rate sample rate
   * @param {object} cfg  see DETECTOR in config.js
   */
  constructor (rate, cfg) {
    this.rate = rate
    this.cfg = cfg

    // Skip any band too close to Nyquist to be meaningful.
    this.bands = cfg.bands.filter((f) => f < rate * 0.45)
    this.n = this.bands.length
    this.needed = Math.min(cfg.bandsNeeded, this.n)

    this.stages = cfg.stages || 1
    this.co = this.bands.map((f) => bandpassCoeffs(f, cfg.q, rate))
    // State is per band per cascade stage.
    const w = this.n * this.stages
    this.x1 = new Float64Array(w)
    this.x2 = new Float64Array(w)
    this.y1 = new Float64Array(w)
    this.y2 = new Float64Array(w)
    this.fast = new Float64Array(this.n)
    this.slow = new Float64Array(this.n)
    this.floor = new Float64Array(this.n).fill(1e-4)
    this.hot = new Int32Array(this.n).fill(-1e9)   // frame each band last triggered

    this.aFast = poleFor(cfg.fastTauMs, rate)
    this.aSlow = poleFor(cfg.slowTauMs, rate)
    // Noise floor creeps up at +6 dB/s and snaps down instantly.
    this.floorRise = Math.pow(10, 6 / 20 / rate)

    // Which bands currently count toward a trigger. Learned per device: a band where
    // the metronome bleed is as loud as her hits is worse than useless, and which bands
    // those are depends entirely on the speaker, the room and the pad.
    this.enabled = new Uint8Array(this.n).fill(1)
    this.enabledCount = this.n

    // Absolute level gate, learned from her actual hits. The ratio test alone fires on
    // ANY transient however quiet — that is what let a click 30 dB below her softest
    // hit trigger the detector. This is the floor that says "too quiet to be a stick".
    this.minLevel = 0

    this.agreeSamples = Math.max(1, Math.round((cfg.agreementMs / 1000) * rate))
    this.frame = 0
    this.lastOnset = -1e9
    this.lastPeak = 0

    // Ring of the summed fast envelope, for measuring attack time by looking back.
    this.histLen = Math.max(64, Math.round(0.03 * rate))
    this.hist = new Float64Array(this.histLen)
    this.histPos = 0

    this.refractorySamples = Math.round((cfg.refractoryMs / 1000) * rate)

    // An onset is reported the instant the attack crosses threshold — correct for
    // TIMING, but the envelope is still climbing, so per-band levels read there are far
    // below the hit's real spectrum. The bleed, sampled at the click's envelope peak, is
    // at its maximum. Comparing the two directly understated every margin by 10-20 dB.
    // So hold the onset briefly and report the peak levels instead. The timestamp is
    // already fixed and travels in the payload, so the delay costs nothing.
    this.levelWindow = Math.round(0.008 * rate)
    this.held = null
  }

  /** Refractory can be tightened per exercise; see refractoryForSpacing(). */
  setRefractoryMs (ms) {
    this.refractorySamples = Math.round((ms / 1000) * this.rate)
  }

  /**
   * Turn bands on and off as the app learns which ones separate her hits from the
   * bleed on THIS device. Never leaves fewer than two enabled: a detector down to one
   * band has no agreement test left and will fire on anything.
   */
  setEnabledBands (mask) {
    let on = 0
    for (let b = 0; b < this.n; b++) {
      this.enabled[b] = mask[b] ? 1 : 0
      on += this.enabled[b]
    }
    if (on < 2) { this.enabled.fill(1); on = this.n }
    this.enabledCount = on
  }

  setMinLevel (v) { this.minLevel = Math.max(0, v || 0) }

  /** How many enabled bands must agree. Scaled so the rule survives disabling bands. */
  get needAgree () {
    return Math.max(2, Math.min(this.enabledCount, Math.round(this.enabledCount * 0.67)))
  }

  /**
   * @param {Float32Array} block
   * @param {number} startFrame absolute frame index of block[0]
   * @returns {Array<{frame:number, strength:number, bands:number, riseMs:number}>}
   */
  process (block, startFrame = this.frame) {
    this.frame = startFrame
    const out = []
    const { cfg } = this

    for (let i = 0; i < block.length; i++) {
      const x = block[i]
      let sum = 0
      let agree = 0

      for (let b = 0; b < this.n; b++) {
        const c = this.co[b]
        let y = x
        for (let st = 0; st < this.stages; st++) {
          const k = b * this.stages + st
          const inp = y
          y = c.b0 * inp + c.b1 * this.x1[k] + c.b2 * this.x2[k]
            - c.a1 * this.y1[k] - c.a2 * this.y2[k]
          this.x2[k] = this.x1[k]; this.x1[k] = inp
          this.y2[k] = this.y1[k]; this.y1[k] = y
        }

        const mag = Math.abs(y)
        this.fast[b] = this.aFast * this.fast[b] + (1 - this.aFast) * mag
        this.slow[b] = this.aSlow * this.slow[b] + (1 - this.aSlow) * mag

        if (this.fast[b] < this.floor[b]) this.floor[b] = this.fast[b]
        else this.floor[b] *= this.floorRise

        if (!this.enabled[b]) continue
        sum += this.fast[b]

        const overSlow = this.fast[b] > cfg.triggerOverSlow * this.slow[b]
        const overFloor = this.fast[b] > cfg.triggerOverFloor * this.floor[b]
        if (overSlow && overFloor) this.hot[b] = this.frame
        // A stick excites every band at once; speaker distortion lights up two or three.
        if (this.frame - this.hot[b] <= this.agreeSamples) agree++
      }

      this.hist[this.histPos] = sum
      this.histPos = (this.histPos + 1) % this.histLen

      if (agree >= this.needAgree && sum > this.minLevel &&
          this.frame - this.lastOnset >= this.refractorySamples) {
        const riseMs = this._riseTime(sum)
        // Speech sibilants ('s', 't' from someone talking) rise over 10 ms or more;
        // a stick on rubber is under 2 ms. Cheapest useful discriminator there is.
        if (riseMs <= cfg.maxRiseMs) {
          const quieterThanLast = this.lastPeak > 0
            ? 20 * Math.log10(sum / this.lastPeak)
            : 0
          const isBounce =
            this.frame - this.lastOnset < (cfg.bounceRejectMs / 1000) * this.rate &&
            quieterThanLast <= -cfg.bounceRejectDb
          if (!isBounce) {
            if (this.held) out.push(this._release())
            this.held = {
              frame: this.frame,
              strength: sum,
              bands: agree,
              riseMs,
              levels: Array.from(this.fast),
              until: this.frame + this.levelWindow,
            }
            this.lastOnset = this.frame
            this.lastPeak = sum
          }
        }
      }
      // While an onset is held, keep the highest level seen in each band.
      if (this.held) {
        for (let b = 0; b < this.n; b++) {
          if (this.fast[b] > this.held.levels[b]) this.held.levels[b] = this.fast[b]
        }
        if (sum > this.held.strength) this.held.strength = sum
        if (this.frame >= this.held.until) out.push(this._release())
      }

      this.frame++
    }
    return out
  }

  _release () {
    const h = this.held
    this.held = null
    this.lastPeak = h.strength
    return { frame: h.frame, strength: h.strength, bands: h.bands, riseMs: h.riseMs, levels: h.levels }
  }

  /** Current per-band envelope, for sampling the bleed at a known moment. */
  snapshot () { return Array.from(this.fast) }

  /** How long ago the summed envelope was at 20% of its current value, in ms. */
  _riseTime (now) {
    if (now <= 0) return 1e6
    const target = now * 0.2
    for (let k = 1; k < this.histLen; k++) {
      const idx = (this.histPos - 1 - k + this.histLen * 2) % this.histLen
      if (this.hist[idx] <= target) return (k / this.rate) * 1000
    }
    return (this.histLen / this.rate) * 1000
  }
}

/**
 * Refractory derived from the exercise rather than fixed.
 *
 * Measured on the real pad: consecutive strikes came as close as 88 ms when playing
 * fast, so a fixed 70 ms would let bounce through while a fixed 150 ms would swallow
 * genuinely fast playing. Tying it to the spacing the exercise actually asks for gets
 * both: generous on slow exercises, tight on quick ones.
 *
 * @param {number} minNoteGapS shortest gap between notes the exercise expects
 */
export function refractoryForSpacing (minNoteGapS) {
  const ms = minNoteGapS * 1000 * 0.4
  return Math.max(60, Math.min(250, ms))
}

/**
 * Listens for the app's own metronome click coming back through the microphone.
 *
 * This is the piece that makes latency calibration continuous and safe. The click is a
 * signal we generated ourselves, arriving every beat, and it has NOTHING to do with how
 * the child is playing — so the delay between scheduling it and hearing it can be
 * re-measured forever without ever contaminating her score.
 *
 * The distinction matters enormously. Adapting the latency constant from HER hits would
 * centre her errors on zero by construction: a child who consistently rushes would be
 * told she is perfect. Adapting it from the click cannot do that.
 *
 * Discriminating a click from a drum hit is easy because they are opposites: the click
 * is sustained narrowband energy with almost nothing up high, a stick is a broadband
 * impulse. Requiring a high narrow-to-bright ratio separates them cleanly.
 */
export class ClickProbe {
  constructor (rate, { freq = 900, q = 8, stages = 2, brightHz = 5000,
                       minRatio = 4, minOverFloor = 6 } = {}) {
    this.rate = rate
    this.minRatio = minRatio
    this.minOverFloor = minOverFloor
    this.stages = stages

    this.narrowCo = bandpassCoeffs(freq, q, rate)
    this.brightCo = bandpassCoeffs(Math.min(brightHz, rate * 0.45), 2.0, rate)
    this.nx1 = new Float64Array(stages); this.nx2 = new Float64Array(stages)
    this.ny1 = new Float64Array(stages); this.ny2 = new Float64Array(stages)
    this.bx1 = 0; this.bx2 = 0; this.by1 = 0; this.by2 = 0

    // ~4 ms smoothing: long enough to ride over the tone's own cycles, short enough
    // to keep the burst's shape.
    this.aEnv = poleFor(4, rate)
    this.nEnv = 0
    this.bEnv = 0
    this.floor = 1e-5
    this.floorRise = Math.pow(10, 6 / 20 / rate)

    this.rising = false
    this.peak = 0
    this.peakFrame = 0
    this.frame = 0
    this.lastEmit = -1e9
    this.minGap = Math.round(0.15 * rate)
  }

  /**
   * @returns {Array<{frame:number, level:number, ratio:number}>} peaks of the click
   *   burst. The peak sits at the CENTRE of the burst, so a caller comparing against a
   *   scheduled time should subtract half the click duration.
   */
  process (block, startFrame = this.frame) {
    this.frame = startFrame
    const out = []

    for (let i = 0; i < block.length; i++) {
      const x = block[i]

      let n = x
      for (let s = 0; s < this.stages; s++) {
        const c = this.narrowCo
        const inp = n
        n = c.b0 * inp + c.b2 * this.nx2[s] - c.a1 * this.ny1[s] - c.a2 * this.ny2[s]
        this.nx2[s] = this.nx1[s]; this.nx1[s] = inp
        this.ny2[s] = this.ny1[s]; this.ny1[s] = n
      }
      const bc = this.brightCo
      const b = bc.b0 * x + bc.b2 * this.bx2 - bc.a1 * this.by1 - bc.a2 * this.by2
      this.bx2 = this.bx1; this.bx1 = x
      this.by2 = this.by1; this.by1 = b

      this.nEnv = this.aEnv * this.nEnv + (1 - this.aEnv) * Math.abs(n)
      this.bEnv = this.aEnv * this.bEnv + (1 - this.aEnv) * Math.abs(b)

      if (this.nEnv < this.floor) this.floor = this.nEnv
      else this.floor *= this.floorRise

      const loud = this.nEnv > this.floor * this.minOverFloor
      if (loud && this.nEnv > this.peak) {
        this.peak = this.nEnv
        this.peakFrame = this.frame
        this.peakBright = this.bEnv
        this.rising = true
      } else if (this.rising && this.nEnv < this.peak * 0.5) {
        // Burst is over: decide whether it was a click or a stick.
        const ratio = this.peak / (this.peakBright + 1e-12)
        if (ratio >= this.minRatio && this.peakFrame - this.lastEmit > this.minGap) {
          out.push({ frame: this.peakFrame, level: this.peak, ratio })
          this.lastEmit = this.peakFrame
        }
        this.rising = false
        this.peak = 0
      }
      this.frame++
    }
    return out
  }
}

/**
 * How late the ClickProbe's reported peak sits relative to the start of the click.
 *
 * The probe reports the peak of a smoothed envelope, which lands somewhere in the
 * middle of the burst — not at its leading edge. That offset is a fixed property of the
 * click waveform and the probe's own filters, so rather than guessing at it (a guess of
 * "half the burst" was 8 ms out), measure it: run the probe over the exact click
 * waveform with no room, no noise and no latency, and see where it says the peak is.
 *
 * @param {Float32Array} clickPcm the synthesised click, as played
 * @returns {number} seconds to subtract from every probe reading
 */
export function probeOffsetSeconds (clickPcm, rate, opts) {
  const padded = new Float32Array(clickPcm.length + Math.round(rate * 0.2))
  padded.set(clickPcm, 0)
  const probe = new ClickProbe(rate, opts)
  const found = []
  for (let i = 0; i < padded.length; i += 128) {
    for (const c of probe.process(padded.subarray(i, Math.min(i + 128, padded.length)), i)) {
      found.push(c.frame)
    }
  }
  return found.length ? found[0] / rate : clickPcm.length / 2 / rate
}
