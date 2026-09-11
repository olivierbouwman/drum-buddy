/**
 * Raw capture worklet for the Phase 0 measurement tool.
 *
 * Deliberately dumb: it copies every sample it is handed straight to the main thread,
 * with no processing at all. Anything clever here would contaminate the very
 * measurements this tool exists to make.
 *
 * Each message carries the AudioContext frame index of its first sample, so the main
 * thread can reassemble the timeline exactly even if messages arrive late or the main
 * thread stalls. Never timestamp on receipt.
 */
class RecorderWorklet extends AudioWorkletProcessor {
  constructor () {
    super()
    this.recording = false
    this.port.onmessage = (e) => {
      if (e.data === 'start') {
        this.recording = true
        this.port.postMessage({ type: 'started', frame: currentFrame, time: currentTime })
      } else if (e.data === 'stop') {
        this.recording = false
      }
    }
  }

  process (inputs) {
    const input = inputs[0]
    // inputs[0] is an empty array whenever the source isn't producing yet.
    if (!input || input.length === 0) return true

    const channel = input[0]
    if (!channel) return true

    if (this.recording) {
      // Copy: the underlying buffer is reused by the audio engine on the next quantum.
      this.port.postMessage({
        type: 'chunk',
        frame: currentFrame,
        samples: new Float32Array(channel),
      })
    }
    return true
  }
}

registerProcessor('recorder-worklet', RecorderWorklet)
