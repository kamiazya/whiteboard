import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findAvailablePort } from '../cli/daemon-run.js'

// `startHttpServer` resolves once `serve()` has been called, not once the
// underlying Node server has actually entered its 'listening' state — the
// existing WS-upgrade test in http-server.test.ts masks this because a real
// TCP connection implicitly waits for listen() to finish. Closing (or even
// just reading status from) a server that hasn't started listening yet can
// make `server.close()` throw ERR_SERVER_NOT_RUNNING, so every test here
// makes one real HTTP round-trip first to synchronize with the real socket.
function waitUntilListening(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (res) => {
      res.resume()
      res.on('end', () => resolve())
    })
    req.on('error', reject)
    req.end()
  })
}

let tmpRoot: string
let distWebAppDir: string

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return tmpRoot
  },
  getDataDir: () => tmpRoot,
  get DIST_WEB_APP_DIR() {
    return distWebAppDir
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
}))

const { startHttpServer } = await import('./http-server.js')

describe('startHttpServer runtime status app.ui / app.buildPresent', () => {
  let running: Awaited<ReturnType<typeof startHttpServer>> | undefined

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'whiteboard-http-status-'))
    distWebAppDir = join(tmpRoot, 'dist-web-app')
    await mkdir(distWebAppDir, { recursive: true })
  })

  afterEach(async () => {
    await running?.close()
    running = undefined
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('reports ui: "pair-only" and buildPresent from dist/web-app', async () => {
    await writeFile(join(distWebAppDir, 'index.html'), '<html></html>')

    const port = await findAvailablePort(4200)
    running = await startHttpServer({ port, host: '127.0.0.1' })
    await waitUntilListening(port)

    const status = running.getRuntimeStatus()
    expect(status.app.ui).toBe('pair-only')
    expect(status.app.buildPresent).toBe(true)
  })

  it('reports buildPresent: false when dist/web-app is missing its index.html', async () => {
    const port = await findAvailablePort(4200)
    running = await startHttpServer({ port, host: '127.0.0.1' })
    await waitUntilListening(port)

    const status = running.getRuntimeStatus()
    expect(status.app.ui).toBe('pair-only')
    expect(status.app.buildPresent).toBe(false)
  })
})
