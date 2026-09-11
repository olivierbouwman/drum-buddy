/**
 * Microphone input source: getUserMedia, the worklet graph, and the plumbing back.
 *
 * The microphone is the TIMING source. Its onsets are stamped on the audio render
 * thread and are sample-accurate; the accelerometer, by contrast, only confirms that a
 * hit happened (see motion-detector.js for why).
 */

import { DETECTOR } from './config.js'
import { InputSource } from './input-sources.js'

/**
 * Open the microphone, stepping down through less and less demanding requests.
 *
 * Raw audio is what the detector wants: echo cancellation, noise suppression and
 * automatic gain all smear or gate the transients it looks for, and echo cancellation
 * would remove the very metronome the latency probe listens for.
 *
 * But some Android stacks answer a request for fully raw audio with a live, permitted,
 * entirely SILENT stream — no error, every sample a zero. That is what this tablet
 * reported while Chrome's own permission page showed the microphone allowed and
 * recently used. A processed stream beats a silent one, so the ladder ends somewhere
 * that always works.
 */
const MIC_LADDER = [
  { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  { echoCancellation: false },
  true,
]

async function openMic (report, from = 0) {
  let lastErr = null
  for (let i = from; i < MIC_LADDER.length; i++) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_LADDER[i] })
      report(i)
      return stream
    } catch (err) { lastErr = err }
  }
  throw lastErr || new Error('NotFoundError')
}

export class MicInput extends InputSource {
  constructor (engine, { recordSeconds = 0 } = {}) {
    super('mic')
    this.engine = engine
    this.recordSeconds = recordSeconds
    this._onAudio = null
    /** Whether audio is actually arriving — separate from whether a stream was granted. */
    this.receiving = false
    this.lastAudioAt = 0
    this.stream = null
    this.node = null
    this.error = null
    this.processing = []        // constraints the browser refused to turn off
    this._onClick = () => {}
    this._onLevel = () => {}
    this.level = 0
  }

  onClick (fn) { this._onClick = fn }
  onLevel (fn) { this._onLevel = fn }

  /** @returns {Promise<boolean>} whether the microphone is usable */
  async init () {
    const ctx = this.engine.ctx
    try {
      this.stream = await openMic((i) => { this.constraintsUsed = i })
    } catch (err) {
      this.error = err.name
      return false
    }

    const track = this.stream.getAudioTracks()[0]
    /*
     * A track can be live, unmuted at the web level, and still deliver nothing.
     *
     * Android's system-wide microphone toggle hands apps SILENCE rather than refusing
     * them, so getUserMedia succeeds, no error is raised, and every sample is a zero.
     * Watching mute/unmute and the permission state is the only way to tell that apart
     * from a genuinely quiet room.
     */
    this.track = track
    track.addEventListener('mute', () => { this.muted = true; this.receiving = false })
    track.addEventListener('unmute', () => { this.muted = false })
    track.addEventListener('ended', () => { this.ended = true; this.receiving = false })
    this.muted = track.muted
    try {
      const status = await navigator.permissions.query({ name: 'microphone' })
      this.permission = status.state
      status.onchange = () => { this.permission = status.state }
    } catch { this.permission = 'unknown' }

    const s = track.getSettings ? track.getSettings() : {}
    this.processing = ['echoCancellation', 'noiseSuppression', 'autoGainControl']
      .filter((k) => s[k] === true)

    // A Bluetooth headset in hands-free mode drops to 16 kHz or below, where there is
    // no energy at all in the bands we listen to. Better to say so than to report
    // nonsense.
    if (ctx.sampleRate < 32000) {
      this.error = 'lowSampleRate'
      return false
    }

    await ctx.audioWorklet.addModule(import.meta.env.BASE_URL + 'onset-worklet.js')

    this.source = ctx.createMediaStreamSource(this.stream)
    this.node = new AudioWorkletNode(ctx, 'drum-onset', {
      processorOptions: { detector: DETECTOR, click: {}, recordSeconds: this.recordSeconds },
    })

    // A worklet with nothing downstream may never be pulled, so route it to the
    // destination through a silent gain: it runs every quantum and feeds back nothing.
    this.mute = ctx.createGain()
    this.mute.gain.value = 0
    this.source.connect(this.node).connect(this.mute).connect(ctx.destination)

    this.node.port.onmessage = (e) => {
      const m = e.data
      if (m.type === 'hit') {
        // m.time is already AudioContext time, stamped on the render thread. Never
        // re-stamp it here.
        this.emit({ time: m.time, strength: m.strength, levels: m.levels, source: 'mic' })
      } else if (m.type === 'click') {
        this._onClick(m.time, m.level, m.levels)
      } else if (m.type === 'noInput') {
        this.receiving = false
      } else if (m.type === 'audio') {
        if (this._onAudio) { this._onAudio(m); this._onAudio = null }
      } else if (m.type === 'level') {
        /*
         * Buffers arriving is not the same as audio arriving.
         *
         * On the tablet the microphone reported itself available, with buffers flowing
         * and no error, while every sample was a digital zero — so "receiving" was true
         * and nothing was wrong as far as the app could tell. A stream of silence is a
         * dead microphone wearing a healthy one's clothes.
         */
        this.lastAudioAt = Date.now()
        this.level = m.peak
        if (m.peak > 0) {
          this.receiving = true
          this.silentSince = 0
        } else {
          if (!this.silentSince) this.silentSince = Date.now()
          if (Date.now() - this.silentSince > 3000) this.receiving = false
        }
        this._onLevel(m.peak, m.levels)
      }
    }

    this.available = true
    return true
  }

  /**
   * Throw the stream away and get a new one.
   *
   * On the real tablet a granted microphone stopped delivering after about fifty
   * milliseconds and never recovered — most likely the previous page still holding the
   * device across a reload. getUserMedia succeeds, the track looks live, and nothing
   * comes out. Re-acquiring is the only cure.
   */
  async reacquire () {
    try {
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop())
      // Step down the ladder each time, so a stack that will not deliver raw audio
      // eventually gets asked for something it will.
      this.attempt = (this.attempt || 0) + 1
      const s = await openMic((i) => { this.constraintsUsed = i }, this.attempt)
      if (this.source) try { this.source.disconnect() } catch {}
      this.stream = s
      this.source = this.engine.ctx.createMediaStreamSource(s)
      this.source.connect(this.node)
      this.receiving = false
      return true
    } catch (err) {
      this.error = err.name
      return false
    }
  }

  /**
   * Ask for the rolling window of raw audio.
   * @returns {Promise<{pcm:Float32Array,startFrame:number,sampleRate:number}|null>}
   */
  dumpAudio (timeoutMs = 4000) {
    if (!this.node || !this.recordSeconds) return Promise.resolve(null)
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this._onAudio = null; resolve(null) }, timeoutMs)
      this._onAudio = (m) => { clearTimeout(timer); resolve(m.empty ? null : m) }
      this.node.port.postMessage({ type: 'dump' })
    })
  }

  /** Apply what the app has learned about this device's bands and levels. */
  tune ({ mask, minLevel }) {
    if (this.node) this.node.port.postMessage({ type: 'tune', mask, minLevel })
  }

  /** Tighten or loosen double-hit rejection to suit the exercise being played. */
  setRefractoryMs (ms) {
    if (this.node) this.node.port.postMessage({ type: 'refractory', ms })
  }

  listen (on) {
    if (this.node) this.node.port.postMessage({ type: 'listen', on })
  }

  stop () {
    if (this.node) this.node.port.postMessage({ type: 'listen', on: false })
  }

  start () {
    if (this.node) this.node.port.postMessage({ type: 'listen', on: true })
  }

  async close () {
    try { if (this.node) this.node.disconnect() } catch {}
    try { if (this.source) this.source.disconnect() } catch {}
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.available = false
  }
}
