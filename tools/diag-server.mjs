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
import { createServer } from 'node:http'

/**
 * A plain-HTTP listener whose only job is to bounce you to the HTTPS one.
 *
 * Typing a bare `192.168.0.x:5174` into Chrome gets you http, which hits a TLS-only
 * server and closes with no reply — ERR_EMPTY_RESPONSE, which looks like the server is
 * down rather than like a scheme mismatch. This makes the wrong URL work anyway.
 */
function startHttpRedirect (httpsPort, httpPort) {
  const srv = createServer((req, res) => {
    const host = (req.headers.host || '').split(':')[0]
    res.writeHead(302, { Location: `https://${host}:${httpsPort}${req.url}` })
    res.end()
  })
  srv.on('error', (e) => console.warn('[diag] redirect listener: ' + e.message))
  srv.listen(httpPort, () => {
    console.log(`[diag] http://<this-machine>:${httpPort}/ redirects to the https server`)
  })
  return srv
}

export function diagServer (dir = 'tools/diag') {
  return {
    name: 'drum-buddy-diag',
    configureServer (server) {
      mkdirSync(dir, { recursive: true })
      /*
       * Whole-session uploads: the beat grid, every detection with its features, the
       * accelerometer trace, and the raw audio of the take. This is what makes it
       * possible to re-run the detector offline against the room she actually plays in,
       * rather than against a recording made once, on purpose, in a quiet room.
       */
      server.middlewares.use('/diag-session', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; return res.end() }
        let body = ''
        req.on('data', (c) => { body += c; if (body.length > 3e7) req.destroy() })
        req.on('end', () => {
          try {
            const d = JSON.parse(body)
            writeFileSync(join(dir, `session-${d.id}.json`), JSON.stringify(d, null, 2))
            console.log(`[diag] session ${d.id}: ${(d.detections || []).length} detections, ` +
              `${(d.notes || []).length} notes, ${(d.motion || []).length} motion samples`)
          } catch (err) { console.warn('[diag] bad session:', err.message) }
          res.statusCode = 204
          res.end()
        })
      })

      server.middlewares.use('/diag-audio', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; return res.end() }
        const id = new URL(req.url, 'http://x').searchParams.get('id') || Date.now()
        const chunks = []
        let size = 0
        req.on('data', (c) => { chunks.push(c); size += c.length; if (size > 6e7) req.destroy() })
        req.on('end', () => {
          const file = join(dir, `session-${id}.wav`)
          writeFileSync(file, Buffer.concat(chunks))
          console.log(`[diag] audio for ${id}: ${(size / 1e6).toFixed(1)} MB -> ${file}`)
          res.statusCode = 204
          res.end()
        })
      })

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
      // Only when serving to the network; there is nothing to rescue on localhost.
      if (server.config.server.host) {
        const port = server.config.server.port || 5174
        startHttpRedirect(port, port + 1)
      }
    },
  }
}
