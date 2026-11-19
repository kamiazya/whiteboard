// @vitest-environment node
/**
 * An abort of the Rust core reaches a caller as the one refusal every engine
 * abort is (`document_engine_trap`, 500), on the legacy `/api` routes and on
 * `/api/v1` alike, and the daemon keeps serving: the core resets itself and
 * the next request is answered.
 */
import { CoreInstanceTrapped, CoreUnrecoverable } from '@kamiazya/whiteboard-core-wasm'
import { apiErrorBodySchema } from '@kamiazya/whiteboard-server-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContainer, resolveServerDeps } from '../di/container.js'
import { storeMemoryModule } from '../shared/test-utils/store-memory.module.js'
import { testDataLayout, withTempDataDir } from './routes/_test-helpers.js'

const tmp = withTempDataDir('whiteboard-app-core-trap-')

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

const TOKEN = 'core-trap-token'
const AUTH = { Authorization: `Bearer ${TOKEN}` }
const ROUTES = [
  ['a legacy route', '/api/workspaces/ws-known/names'],
  ['an /api/v1 route', '/api/v1/workspaces/ws-known/documents'],
] as const

function daemonWhoseNextCallThrows(error: unknown) {
  const serverDeps = resolveServerDeps(createContainer(storeMemoryModule))
  vi.spyOn(serverDeps.documentIndex, 'resolveWorkspace').mockRejectedValueOnce(error)
  return createApp({
    authMode: 'local-daemon',
    token: TOKEN,
    touch: () => {},
    getStatus: () => ({}) as never,
    serverDeps,
    dataLayout: testDataLayout(),
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a core abort inside a request', () => {
  it.each(
    ROUTES,
  )('on %s answers document_engine_trap naming the operation, and the next request is served', async (_name, path) => {
    const app = daemonWhoseNextCallThrows(
      new CoreInstanceTrapped('layout_spatial', 1, { cause: new Error('unreachable') }),
    )

    const trapped = await app.request(path, { headers: AUTH })
    const body = apiErrorBodySchema.parse(await trapped.json())

    expect(trapped.status).toBe(500)
    expect(body.error).toBe('document_engine_trap')
    expect(body.message).toContain('layout_spatial')
    const next = await app.request(path, { headers: AUTH })
    expect(next.status).not.toBe(500)
  })

  it('answers an instance that could not be reset as the same refusal, saying so', async () => {
    const app = daemonWhoseNextCallThrows(
      new CoreUnrecoverable('search', { cause: new Error('unreachable') }),
    )

    const res = await app.request(ROUTES[1][1], { headers: AUTH })

    expect(res.status).toBe(500)
    const body = apiErrorBodySchema.parse(await res.json())
    expect(body.error).toBe('document_engine_trap')
    expect(body.message).toContain('until the daemon restarts')
  })
})
