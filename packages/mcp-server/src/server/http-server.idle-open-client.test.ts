import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { findAvailablePort } from '../cli/daemon-run.js'

/**
 * "Idle" is no CLIENT, not no REQUEST. A page holding a sync stream open is
 * one request, made once; before this, the idle timer counted it at its start
 * and stopped the daemon under a page someone was still looking at.
 */

let tmpRoot: string

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return tmpRoot
  },
  getDataDir: () => tmpRoot,
  get DIST_WEB_APP_DIR() {
    return join(tmpRoot, 'no-web-app')
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
}))

const { startHttpServer } = await import('./http-server.js')

const TOKEN = 'idle-open-client-token'
// Long enough that the stream's own open cannot land after it, short enough
// that waiting past it twice stays well inside the test budget.
const IDLE_MS = 400

let running: Awaited<ReturnType<typeof startHttpServer>> | undefined

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'whiteboard-idle-open-client-'))
})

afterEach(async () => {
  await running?.close()
  running = undefined
  await rm(tmpRoot, { recursive: true, force: true })
})

/** Opens the sync stream and resolves once its first frame has arrived. */
function openStream(port: number): Promise<{ end: () => void; ended: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/sync/stream',
        headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'text/event-stream' },
      },
      (res) => {
        const ended = new Promise<void>((done) => {
          res.on('close', () => done())
        })
        res.once('data', () => resolve({ end: () => req.destroy(), ended }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

it('stays up while a sync stream is open, and stops once it closes', async () => {
  const port = await findAvailablePort(4300)
  const closed = vi.fn()
  running = await startHttpServer({
    port,
    host: '127.0.0.1',
    token: TOKEN,
    idleTimeoutMs: IDLE_MS,
    onClose: closed,
  })
  const stream = await openStream(port)

  // Well past the timeout with no request but the held stream.
  await vi.waitFor(
    () => expect(running?.getRuntimeStatus().idleForMs).toBeGreaterThan(IDLE_MS * 2),
    {
      timeout: IDLE_MS * 10,
    },
  )
  expect(closed).not.toHaveBeenCalled()

  stream.end()
  await stream.ended
  await vi.waitFor(() => expect(closed).toHaveBeenCalled(), { timeout: IDLE_MS * 10 })
  running = undefined
})
