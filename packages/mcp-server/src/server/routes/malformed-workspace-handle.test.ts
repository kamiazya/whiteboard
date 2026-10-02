/**
 * A malformed workspace address answers the same 400 on every route that
 * takes one: the address is refused before the store is touched, in the
 * `{ error, message }` family — except the page-facing workspace-document
 * surface, which speaks Problem Details and is pinned here so the difference
 * stays deliberate.
 *
 * `workspace-handle.test.ts` pins the helper; this is the per-route half, so
 * a handler that stops calling it fails by name.
 */
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveTestServerDeps, testStoreScope, withTempDataDir } from './_test-helpers.js'

const tmp = withTempDataDir('whiteboard-malformed-handle-')

let serverDeps: ServerDeps
beforeEach(async () => {
  serverDeps = await resolveTestServerDeps(tmp.dir)
})

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createDocumentRouter } = await import('./document.js')
const { createFilesRouter } = await import('./files.js')

const MALFORMED = 'bad.handle'
const REFUSAL = {
  error: 'invalid_workspace_id',
  message: `Invalid workspaceId "${MALFORMED}": only ASCII letters, digits, "_" and "-" are allowed`,
}

const versionStore = { pruneSandwichedAutoVersions: vi.fn() } as never

const ROUTES: readonly { method: string; path: string; body?: string }[] = [
  { method: 'GET', path: `/api/workspaces/${MALFORMED}/names` },
  {
    method: 'PUT',
    path: `/api/workspaces/${MALFORMED}/name`,
    body: JSON.stringify({ name: 'x' }),
  },
  { method: 'GET', path: `/api/workspaces/${MALFORMED}/trash` },
  { method: 'POST', path: `/api/workspaces/${MALFORMED}/trash/doc-1/restore` },
  { method: 'POST', path: `/api/workspaces/${MALFORMED}/versions/prune-sandwiched` },
  { method: 'POST', path: `/api/workspaces/${MALFORMED}/documents/optimize-all` },
  { method: 'POST', path: `/api/workspaces/${MALFORMED}/files/purge-dangling` },
  {
    method: 'PATCH',
    path: `/api/workspaces/${MALFORMED}`,
    body: JSON.stringify({ displayName: 'x' }),
  },
  { method: 'GET', path: `/api/workspaces/${MALFORMED}/documents` },
]

describe('a malformed workspace handle', () => {
  for (const { method, path, body } of ROUTES) {
    it(`is a 400 { error, message } on ${method} ${path.replace(MALFORMED, ':workspaceId')}`, async () => {
      const app = createDocumentRouter({ scope: testStoreScope(), serverDeps, versionStore })
      app.route('/', createFilesRouter({ scope: testStoreScope(tmp.dir) }))
      const res = await app.request(path, {
        method,
        ...(body === undefined ? {} : { body, headers: { 'Content-Type': 'application/json' } }),
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual(REFUSAL)
    })
  }

  it('is Problem Details { title } on the page-facing workspace-document surface', async () => {
    const app = createDocumentRouter({ scope: testStoreScope(), serverDeps, versionStore })
    const res = await app.request(`/api/w/${MALFORMED}/workspace-document/snapshot`)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ title: REFUSAL.message })
  })
})
