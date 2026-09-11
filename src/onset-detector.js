/**
 * Microphone input source: getUserMedia, the worklet graph, and the plumbing back.
 *
 * The microphone is the TIMING source. Its onsets are stamped on the audio render
 * thread and are sample-accurate; the accelerometer, by contrast, only confirms that a
 * hit happened (see motion-detector.js for why).
 */

import { DETECTOR } from './config.js'
import { InputSource } from './input-sources.js'

export class MicInput extends InputSource {
  constructor (engine) {
    super('mic')
    this.engine = engine
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
      // Every one of these would smear or gate the transients we detect, so they must
      // be off. Safari and Android honour them inconsistently, hence the read-back.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      })
    } catch (err) {
      this.error = err.name
      return false
    }

    const track = this.stream.getAudioTracks()[0]
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
      processorOptions: { detector: DETECTOR, click: {} },
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
      } else if (m.type === 'level') {
        this.level = m.peak
        this._onLevel(m.peak, m.levels)
      }
    }

    this.available = true
    return true
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
