#!/usr/bin/env node
/**
 * Bundle the AudioWorklet into a single self-contained file in public/.
 *
 * AudioWorklet modules are loaded by URL, outside the app's module graph, so a plain
 * `import` of dsp-core.js would 404 in a production build. Bundling here keeps ONE
 * source of truth: the detector that runs in the app is literally the one tuned against
 * the Phase 0 recordings. A hand-copied duplicate would drift, and the tuning would
 * quietly stop meaning anything.
 */
import { build } from 'vite'

await build({
  configFile: false,
  logLevel: 'warn',
  build: {
    lib: {
      entry: new URL('../src/worklets/onset-processor.js', import.meta.url).pathname,
      formats: ['es'],
      fileName: () => 'onset-worklet.js',
    },
    outDir: new URL('../public', import.meta.url).pathname,
    emptyOutDir: false,
    minify: false,
    target: 'es2022',
  },
})
console.log('built public/onset-worklet.js')
