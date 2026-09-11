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

    this.agreeSamples = Math.max(1, Math.round((cfg.agreementMs / 1000) * rate))
    this.frame = 0
    this.lastOnset = -1e9
    this.lastPeak = 0

    // Ring of the summed fast envelope, for measuring attack time by looking back.
    this.histLen = Math.max(64, Math.round(0.03 * rate))
    this.hist = new Float64Array(this.histLen)
    this.histPos = 0

    this.refractorySamples = Math.round((cfg.refractoryMs / 1000) * rate)
  }

  /** Refractory can be tightened per exercise; see refractoryForSpacing(). */
  setRefractoryMs (ms) {
    this.refractorySamples = Math.round((ms / 1000) * this.rate)
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

        sum += this.fast[b]

        const overSlow = this.fast[b] > cfg.triggerOverSlow * this.slow[b]
        const overFloor = this.fast[b] > cfg.triggerOverFloor * this.floor[b]
        if (overSlow && overFloor) this.hot[b] = this.frame
        // A stick excites every band at once; speaker distortion lights up two or three.
        if (this.frame - this.hot[b] <= this.agreeSamples) agree++
      }

      this.hist[this.histPos] = sum
      this.histPos = (this.histPos + 1) % this.histLen

      if (agree >= this.needed && this.frame - this.lastOnset >= this.refractorySamples) {
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
            out.push({ frame: this.frame, strength: sum, bands: agree, riseMs })
            this.lastOnset = this.frame
            this.lastPeak = sum
          }
        }
      }
      this.frame++
    }
    return out
  }

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
