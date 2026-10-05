/**
 * A busy database is the one failure a caller can do something about — wait
 * and retry — and the app's `onError` answers it as such: 503
 * `database_busy` with `Retry-After`. A route whose catch-all turns every
 * unowned error into its own 500 hides that answer, so each one lets a busy
 * database escape to `onError` instead.
 */

import { answerUnhandled } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { testDocumentRouterOptions, withTempDataDir } from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-database-busy-test-')

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createDocumentRouter } = await import('../document.js')
const { createContainer, resolveServerDeps } = await import('../../../di/container.js')
const { createSelfHostStoreLocalModule } = await import('../../../di/store-local.module.js')
const { prepareDataDir } = await import('../../store/db/prepare.js')
const { getDb } = await import('../../store/db/index.js')

/** The shape libsql raises: recognised by its code, as `isDatabaseBusy` reads it. */
const busy = (): Error => Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })

const BUSY_METHODS = new Set(['resolveDocument', 'listTrash', 'restoreDocument', 'purgeTrashEntry'])

async function appOverABusyIndex() {
  await prepareDataDir(tmp.dir)
  const deps = resolveServerDeps(
    createContainer(createSelfHostStoreLocalModule(await getDb(tmp.dir), tmp.dir)),
  )
  await deps.documentIndex.createWorkspace({ workspaceId: 'ws-busy' })
  const documentIndex = new Proxy(deps.documentIndex, {
    get(target, key, receiver) {
      if (typeof key === 'string' && BUSY_METHODS.has(key))
        return async () => Promise.reject(busy())
      return Reflect.get(target, key, receiver)
    },
  })
  const app = new Hono()
  app.onError(answerUnhandled(() => {}))
  app.route(
    '/',
    createDocumentRouter(testDocumentRouterOptions({ serverDeps: { ...deps, documentIndex } })),
  )
  return app
}

describe('a busy database escapes the route catch-alls to the 503 answer', () => {
  it.each([
    ['deleting a document', 'DELETE', '/api/workspaces/ws-busy/documents/a', undefined],
    [
      'renaming a document',
      'PUT',
      '/api/workspaces/ws-busy/documents/a/path',
      JSON.stringify({ path: 'b' }),
    ],
    ['listing the trash', 'GET', '/api/workspaces/ws-busy/trash', undefined],
    [
      'restoring from the trash',
      'POST',
      '/api/workspaces/ws-busy/trash/01H8XJZ9K5N4M3P2Q1R0S9T8V7/restore',
      undefined,
    ],
    [
      'purging from the trash',
      'DELETE',
      '/api/workspaces/ws-busy/trash/01H8XJZ9K5N4M3P2Q1R0S9T8V7',
      undefined,
    ],
  ] as const)('%s', async (_name, method, path, body) => {
    const app = await appOverABusyIndex()

    const res = await app.request(path, {
      method,
      ...(body === undefined ? {} : { body, headers: { 'Content-Type': 'application/json' } }),
    })

    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('1')
    expect(await res.json()).toMatchObject({ error: 'database_busy' })
  })
})
