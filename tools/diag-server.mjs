/**
 * Vite middleware that receives diagnostics from the tablet.
 *
 * Family Link blocks developer options on a supervised tablet, so adb and Chrome remote
 * debugging are off the table. This gets the same thing a different way: the tablet
 * loads the app from this machine over the local network and posts what it sees back.
 *
 * Deliberately local-only. It is wired into the DEV server, so it exists only while
 * someone is deliberately debugging on this machine; the published app on GitHub Pages
 * has no idea it exists and sends nothing anywhere. What it receives is measurements —
 * levels, latencies, counts — never audio.
 */
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

export function diagServer (dir = 'tools/diag') {
  return {
    name: 'drum-buddy-diag',
    configureServer (server) {
      mkdirSync(dir, { recursive: true })
      server.middlewares.use('/diag', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          return res.end('post only')
        }
        let body = ''
        req.on('data', (c) => {
          body += c
          if (body.length > 2e6) req.destroy()      // don't let a bug fill the disk
        })
        req.on('end', () => {
          try {
            const data = JSON.parse(body)
            const stamp = new Date().toISOString().replace(/[:.]/g, '-')
            writeFileSync(join(dir, `${stamp}.json`), JSON.stringify(data, null, 2))
            // A one-line-per-snapshot log is much easier to skim than a folder of files.
            appendFileSync(join(dir, 'log.ndjson'), JSON.stringify(data) + '\n')
            const t = data.timing || {}
            const d = data.detection || {}
            console.log(`[diag] ${data.screen || '?'}  timing=${t.status}${t.approximate ? '~' : ''} ` +
              `${t.latencyMs === null || t.latencyMs === undefined ? '?' : Math.round(t.latencyMs)}ms ` +
              `hits=${d.hits}/${d.notes} from=${(data.sensors || {}).timingFrom}`)
          } catch (err) {
            console.warn('[diag] bad payload:', err.message)
          }
          res.statusCode = 204
          res.end()
        })
      })
      console.log('[diag] collecting tablet diagnostics into ' + dir)
    },
  }
}
