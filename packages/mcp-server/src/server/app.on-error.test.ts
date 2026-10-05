// @vitest-environment node
/**
 * A throw no route anticipated answers the daemon's JSON refusal on the legacy
 * `/api` routes and on `/api/v1` alike, and is logged through the project
 * logger. Hono's own default answers `text/plain` and prints the raw error with
 * `console.error`, which the server must never do.
 */
import { apiErrorBodySchema } from '@kamiazya/whiteboard-server-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer, resolveServerDeps } from '../di/container.js'
import { storeMemoryModule } from '../shared/test-utils/store-memory.module.js'
import { captureLogsForTests } from './log.js'
import { testDataLayout, withTempDataDir } from './routes/_test-helpers.js'

const tmp = withTempDataDir('whiteboard-app-on-error-')

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
  DIST_WEB_APP_DIR: '/tmp/whiteboard/dist/web-app',
}))

const { createApp } = await import('./app.js')

const TOKEN = 'on-error-token'
const AUTH = { Authorization: `Bearer ${TOKEN}` }
const ROUTES = [
  ['a legacy route', '/api/workspaces/ws-known/names'],
  ['an /api/v1 route', '/api/v1/workspaces/ws-known/documents'],
] as const

function daemonWhoseIndexThrows(error: unknown) {
  const serverDeps = resolveServerDeps(createContainer(storeMemoryModule))
  vi.spyOn(serverDeps.documentIndex, 'resolveWorkspace').mockRejectedValue(error)
  return createApp({
    authMode: 'local-daemon',
    token: TOKEN,
    touch: () => {},
    getStatus: () => ({}) as never,
    serverDeps,
    dataLayout: testDataLayout(),
  })
}

let capture: ReturnType<typeof captureLogsForTests>
let consoleError: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  capture = captureLogsForTests('warning')
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  capture.restore()
  vi.restoreAllMocks()
})

describe('an unhandled throw', () => {
  it.each(ROUTES)('on %s answers a JSON 500 that does not echo the error', async (_name, path) => {
    const app = daemonWhoseIndexThrows(new Error('boom secret=abc123'))

    const res = await app.request(path, { headers: AUTH })

    expect(res.status).toBe(500)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.text()
    expect(apiErrorBodySchema.parse(JSON.parse(body))).toMatchObject({ error: 'internal_error' })
    expect(body).not.toContain('abc123')
  })

  it.each(
    ROUTES,
  )('on %s is logged through the project logger, not the console', async (_name, path) => {
    const app = daemonWhoseIndexThrows(new Error('boom'))

    await app.request(path, { headers: AUTH })

    expect(consoleError).not.toHaveBeenCalled()
    const logged = capture.records.filter((r) => r.level === 'error')
    expect(logged).toHaveLength(1)
    expect(logged[0]?.data).toMatchObject({
      method: 'GET',
      path,
      err: { message: 'boom' },
    })
  })

  it.each(
    ROUTES,
  )('on %s answers 503 database_busy for a database that stayed locked', async (_name, path) => {
    const busy = Object.assign(new Error('database stayed locked'), {
      name: 'DatabaseBusyError',
      code: 'SQLITE_BUSY',
    })
    const app = daemonWhoseIndexThrows(busy)

    const res = await app.request(path, { headers: AUTH })

    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('1')
    expect(apiErrorBodySchema.parse(await res.json())).toMatchObject({ error: 'database_busy' })
    expect(consoleError).not.toHaveBeenCalled()
    // A refusal the caller is told to retry is not a fault: warning, never error.
    expect(capture.records.map((r) => [r.level, r.data?.path])).toEqual([['warning', path]])
  })

  it('still carries the baseline security headers', async () => {
    const res = await daemonWhoseIndexThrows(new Error('boom')).request(ROUTES[0][1], {
      headers: AUTH,
    })

    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })
})
