/**
 * Learns, on the fly, which frequency bands actually separate her drum from the
 * metronome bleeding out of this particular speaker, in this particular room.
 *
 * This replaces the offline recording-and-analysis step. The app already has everything
 * that step provided:
 *
 *   - It knows exactly when it played a click, and the ClickProbe reports exactly when
 *     that click came back through the microphone. Sampling the filterbank at that
 *     instant measures the BLEED spectrum.
 *   - The four-beat count-in is a guaranteed silent window: the metronome is playing and
 *     she is definitely not. It happens at the start of every exercise, so clean bleed
 *     samples keep arriving forever, for free.
 *   - Every detected hit carries its own per-band levels, which measures the HIT
 *     spectrum.
 *
 * Margin per band is the difference. Bands where the bleed is as loud as her hits are
 * switched off; the rest set an absolute level gate that sits between the two.
 *
 * Being deliberately careful in two directions:
 *   - Bleed is taken at a HIGH percentile and hits at a LOW one, so the margin is the
 *     pessimistic case rather than the flattering average.
 *   - The gate can never rise above her softest hits. Silently going deaf would look
 *     to her exactly like the app ignoring her, which is worse than a false trigger.
 *
 * None of this touches WHEN a hit is reported, only WHETHER — so adapting mid-session
 * cannot skew her timing.
 */

/**
 * Below this a band is more trouble than it's worth.
 *
 * Set low on purpose. Multiband agreement — "at least four of six must fire together" —
 * turns out to be the strongest discriminator against the metronome, so THINNING the
 * band set weakens the very rule that does the work: drop to three bands and the rule
 * quietly becomes "at least two", and click rejection got worse rather than better.
 * Only bands that are genuinely useless should go.
 */
const MIN_MARGIN_DB = 4
/**
 * A band is also dropped if it is this far behind the best band available.
 *
 * A purely absolute threshold cannot win here. Set it high and the band set gets thin,
 * which hollows out the agreement rule that does most of the work. Set it low and the
 * metronome's OWN band sneaks back in on a slim positive margin — 1 kHz measured +4.4 dB
 * and was admitted, which is the one band that must never be. Judging each band against
 * the best one available separates those cases cleanly.
 */
const RELATIVE_DB = 18
const MIN_BLEED_SAMPLES = 5
const MIN_HIT_SAMPLES = 4
/**
 * Hits needed before an absolute level gate is applied at all.
 *
 * Four warm-up whacks are not a fair sample of how she plays. Setting the gate from
 * them made the app deaf to normal playing: she hits hard to wake the band, the gate is
 * pinned to that, and everything quieter is silently dropped. Band separation alone
 * already gives zero false triggers from the metronome, so the gate is belt-and-braces
 * and can afford to wait for real evidence.
 */
const MIN_HITS_FOR_GATE = 12
const KEEP = 40               // rolling window per band

const percentile = (arr, p) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]
}
const db = (a, b) => 20 * Math.log10((a + 1e-12) / (b + 1e-12))

export class AutoTune {
  constructor (bands) {
    this.bands = bands
    this.n = bands.length
    this.bleed = bands.map(() => [])
    this.hits = bands.map(() => [])
    this.room = bands.map(() => [])
    this.bleedSums = []
    this.hitSums = []
    this.mask = bands.map(() => 1)
    this.minLevel = 0
    this.ready = false
    this.problem = null
    this.noisyRoom = false
  }

  /** Filterbank levels at the moment a metronome click arrived, with nobody playing. */
  sampleBleed (levels) {
    if (!levels || levels.length !== this.n) return
    let sum = 0
    for (let b = 0; b < this.n; b++) {
      this.bleed[b].push(levels[b])
      if (this.bleed[b].length > KEEP) this.bleed[b].shift()
      sum += levels[b]
    }
    this.bleedSums.push(sum)
    if (this.bleedSums.length > KEEP) this.bleedSums.shift()
  }

  /**
   * Filterbank levels with nothing happening at all — no click, no stick.
   *
   * This is the room itself, and it is a different thing from the bleed: the bleed says
   * how loud the speaker is in each band, the room says how loud everything else is.
   * A band can be clear of the metronome and still be useless because a fan or a
   * television is sitting in it.
   */
  sampleRoom (levels) {
    if (!levels || levels.length !== this.n) return
    for (let b = 0; b < this.n; b++) {
      this.room[b].push(levels[b])
      if (this.room[b].length > KEEP) this.room[b].shift()
    }
  }

  /** Filterbank levels at the moment she hit the pad. */
  sampleHit (levels) {
    if (!levels || levels.length !== this.n) return
    let sum = 0
    for (let b = 0; b < this.n; b++) {
      this.hits[b].push(levels[b])
      if (this.hits[b].length > KEEP) this.hits[b].shift()
      sum += levels[b]
    }
    this.hitSums.push(sum)
    if (this.hitSums.length > KEEP) this.hitSums.shift()
  }

  get enoughData () {
    return this.bleedSums.length >= MIN_BLEED_SAMPLES && this.hitSums.length >= MIN_HIT_SAMPLES
  }

  /**
   * Recompute the band mask and level gate.
   * @returns {{mask:number[], minLevel:number, changed:boolean}|null}
   */
  decide () {
    if (!this.enoughData) return null

    const margins = []
    for (let b = 0; b < this.n; b++) {
      // Pessimistic on both sides: loud bleed against quiet hits.
      const bleedHigh = percentile(this.bleed[b], 0.8)
      const roomHigh = this.room[b].length >= 5 ? percentile(this.room[b], 0.9) : 0
      const hitLow = percentile(this.hits[b], 0.25)
      // A band has to beat whichever interferer is louder — the speaker or the room.
      margins.push(db(hitLow, Math.max(bleedHigh, roomHigh)))
    }

    const best = Math.max(...margins)
    const bar = Math.max(MIN_MARGIN_DB, best - RELATIVE_DB)
    const mask = margins.map((m) => (m >= bar ? 1 : 0))

    /*
     * Prefer a wide band set, because agreement is what rejects the metronome and a thin
     * set hollows that rule out. But never widen by re-admitting a band the interferer
     * OWNS: force-keeping the top few by margin would happily switch the click's own
     * band back on, which is worse than having fewer bands.
     */
    this.problem = null
    const ranked = margins.map((m, i) => [m, i]).sort((a, b) => b[0] - a[0])
    const MIN_BANDS = 3

    if (mask.filter(Boolean).length < MIN_BANDS) {
      // Widen, but only into bands that are at least not actively harmful.
      for (const [m, i] of ranked) {
        if (mask.filter(Boolean).length >= MIN_BANDS) break
        if (m > 0) mask[i] = 1
      }
      this.problem = 'weakSeparation'
    }
    if (mask.filter(Boolean).length < MIN_BANDS) {
      // Nothing here separates at all. Take the least bad rather than go deaf, and say so.
      for (const [, i] of ranked) {
        if (mask.filter(Boolean).length >= MIN_BANDS) break
        mask[i] = 1
      }
      this.problem = 'noSeparation'
    }

    // Totals must be taken over the ENABLED bands only. Summing across every candidate
    // means the bleed total is dominated by the very bands just switched off — which is
    // how the click bands were still setting the gate for a detector that no longer
    // listens to them.
    const sumOver = (perBand) => {
      const count = perBand[0].length
      const out = []
      for (let i = 0; i < count; i++) {
        let t = 0
        for (let b = 0; b < this.n; b++) if (mask[b]) t += perBand[b][i] || 0
        out.push(t)
      }
      return out
    }
    const hitTotals = sumOver(this.hits)
    const bleedTotals = sumOver(this.bleed)

    // Gate between the loudest bleed and her softest hits — but only once there is
    // enough evidence, and never close enough to her quietest hit to swallow it.
    const softHit = percentile(hitTotals, 0.1)
    const loudBleed = percentile(bleedTotals, 0.9)
    let minLevel = 0
    if (hitTotals.length >= MIN_HITS_FOR_GATE) {
      // A third of her quietest observed hit leaves three times the headroom the old
      // three-quarters did, which is the difference between cautious and deaf.
      minLevel = Math.min(Math.max(loudBleed * 1.5, softHit * 0.15), softHit * 0.35)
    }

    // Only worth flagging when there is genuinely no room between them. A few dB of
    // headroom is tight but perfectly workable, and crying wolf at 6 dB would have the
    // debug panel permanently red on a device that works fine.
    if (loudBleed >= softHit) this.problem = 'bleedLouderThanHits'

    // Is the room itself the problem, rather than the speaker?
    if (this.room[0].length >= 5) {
      let roomTotal = 0
      for (let b = 0; b < this.n; b++) if (mask[b]) roomTotal += percentile(this.room[b], 0.9)
      this.noisyRoom = roomTotal > softHit * 0.5
      if (this.noisyRoom && !this.problem) this.problem = 'noisyRoom'
    }

    const changed = mask.some((v, i) => v !== this.mask[i]) ||
      Math.abs(minLevel - this.minLevel) > this.minLevel * 0.25
    this.mask = mask
    this.minLevel = minLevel
    this.margins = margins
    this.ready = true
    return { mask, minLevel, changed }
  }

  /** Human-readable state, for the debug panel. */
  get report () {
    return {
      ready: this.ready,
      problem: this.problem,
      bleedSamples: this.bleedSums.length,
      hitSamples: this.hitSums.length,
      roomSamples: this.room[0].length,
      noisyRoom: this.noisyRoom,
      bands: this.bands.map((f, i) => ({
        hz: f,
        on: !!this.mask[i],
        marginDb: this.margins ? Math.round(this.margins[i] * 10) / 10 : null,
      })),
      minLevel: this.minLevel,
    }
  }
}
