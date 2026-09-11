import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { resolve } from 'node:path'

// Two things need a secure context: getUserMedia and DeviceMotionEvent. On the Mac,
// http://localhost counts as secure and needs nothing. On the iPad it does not — so
// the deployed GitHub Pages URL is the easiest way to test there, and `npm run dev:lan`
// serves https locally with a self-signed cert (accept the warning once).
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/drum-buddy/' : '/',
  // https only when asked for: localhost is already a secure context, but a phone or
  // tablet on the LAN is not, and getUserMedia/DeviceMotion both require one.
  plugins: process.env.HTTPS ? [basicSsl()] : [],
  server: {
    port: 5174,
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    rollupOptions: {
      input: {
        // The Phase 0 measurement tool ships with the app so it can be run from the
        // iPad, which needs https that localhost can't provide.
        main: resolve(process.cwd(), 'index.html'),
        record: resolve(process.cwd(), 'tools/record.html'),
      },
    },
  },
}))
