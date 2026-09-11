/** Minimal WAV reader shared by the Phase 0 tools. Float32 and 16-bit PCM. */
import { readFileSync } from 'node:fs'

export function readWav (path) {
  const b = readFileSync(path)
  if (b.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a RIFF file')
  let off = 12, fmt = null, data = null
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4)
    const size = b.readUInt32LE(off + 4)
    const body = off + 8
    if (id === 'fmt ') {
      fmt = { format: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2),
              rate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) }
    } else if (id === 'data') {
      data = { start: body, size: Math.min(size, b.length - body) }
    }
    off = body + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('missing fmt or data chunk')
  const ch = fmt.channels
  let n, get
  if (fmt.format === 3 && fmt.bits === 32) {
    n = Math.floor(data.size / 4 / ch); get = (i) => b.readFloatLE(data.start + i * 4 * ch)
  } else if (fmt.format === 1 && fmt.bits === 16) {
    n = Math.floor(data.size / 2 / ch); get = (i) => b.readInt16LE(data.start + i * 2 * ch) / 32768
  } else throw new Error(`unsupported wav: format ${fmt.format}, ${fmt.bits}-bit`)
  const pcm = new Float32Array(n)
  for (let i = 0; i < n; i++) pcm[i] = get(i)
  return { pcm, rate: fmt.rate }
}
