/**
 * A folder's display name over the daemon's `/api`: listed beside the
 * documents, written by `PUT …/folders/name`, refused for what every
 * folder-name writer refuses — and for a name a sibling folder already shows.
 */
import {
  listDocumentsResponseSchema,
  setFolderNameResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import type { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDocument, resolveTestServerDeps, withTempDataDir } from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-folder-names-test-')

let serverDeps: ServerDeps
beforeEach(async () => {
  serverDeps = await resolveTestServerDeps(tmp.dir)
})

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { clearDocCacheForTests } = await import('../../store/doc-cache.js')
const { createWorkspacesRouter } = await import('./workspaces.js')

beforeEach(() => clearDocCacheForTests())
afterEach(() => clearDocCacheForTests())

const WS = 'ws1'

const rename = (app: Hono, body: unknown) =>
  app.request(`/api/workspaces/${WS}/folders/name`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

async function listed(app: Hono) {
  const res = await app.request(`/api/workspaces/${WS}/documents`)
  expect(res.status).toBe(200)
  return listDocumentsResponseSchema.parse(await res.json())
}

describe('PUT /api/workspaces/:workspaceId/folders/name', () => {
  beforeEach(async () => {
    await createTestDocument(serverDeps, { workspaceId: WS, path: 'term/week-6/plan' })
    await createTestDocument(serverDeps, { workspaceId: WS, path: 'term/w7/plan' })
  })

  it('names a folder, which the listing then carries beside unmoved documents', async () => {
    const app = createWorkspacesRouter({ serverDeps })

    const res = await rename(app, { path: 'term/week-6', name: 'Week 6' })

    expect(res.status).toBe(200)
    expect(setFolderNameResponseSchema.parse(await res.json())).toEqual({ ok: true })
    const after = await listed(app)
    expect(after.folderNames).toEqual([{ path: 'term/week-6', name: 'Week 6' }])
    expect(after.documents.map((d) => d.path).sort()).toEqual(['term/w7/plan', 'term/week-6/plan'])
  })

  it('clears a name when the body carries none', async () => {
    const app = createWorkspacesRouter({ serverDeps })
    await rename(app, { path: 'term/week-6', name: 'Week 6' })

    expect((await rename(app, { path: 'term/week-6' })).status).toBe(200)

    expect((await listed(app)).folderNames).toBeUndefined()
  })

  it('answers 409 display_name_taken for a name a sibling folder shows', async () => {
    const app = createWorkspacesRouter({ serverDeps })
    await rename(app, { path: 'term/week-6', name: 'Week 6' })

    const res = await rename(app, { path: 'term/w7', name: 'week 6' })

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({
      error: 'display_name_taken',
      message: expect.stringMatching(/already called "week 6"/),
    })
    expect((await listed(app)).folderNames).toEqual([{ path: 'term/week-6', name: 'Week 6' }])
  })

  it('answers 404 for a path no folder stands at', async () => {
    const app = createWorkspacesRouter({ serverDeps })
    const res = await rename(app, { path: 'term/week-6/plan', name: 'Plan' })
    expect(res.status).toBe(404)
  })

  it.each([['   '], ['a/b']])('answers 400 for the folder name %j', async (name) => {
    const app = createWorkspacesRouter({ serverDeps })
    const res = await rename(app, { path: 'term/week-6', name })
    expect(res.status).toBe(400)
    expect((await listed(app)).folderNames).toBeUndefined()
  })
})
