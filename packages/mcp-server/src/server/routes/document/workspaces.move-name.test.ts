import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestDocument,
  resolveTestServerDeps,
  seedWorkspaceRow,
  testDocumentRouterOptions,
  withTempDataDir,
} from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-move-name-test-')

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

const { createDocumentRouter } = await import('../document.js')

describe('PUT /api/workspaces/:workspaceId/documents/:path/path', () => {
  beforeEach(async () => {
    await mkdir(join(tmp.dir, 'session1'), { recursive: true })
    await seedWorkspaceRow(tmp.dir, 'session1')
  })

  it('answers 409 display_name_taken when the move lands beside a sibling showing its name', async () => {
    await createTestDocument(serverDeps, {
      workspaceId: 'session1',
      path: 'week/plan',
      name: 'Plan',
    })
    await createTestDocument(serverDeps, { workspaceId: 'session1', path: 'month/x', name: 'plan' })
    const app = createDocumentRouter(testDocumentRouterOptions({ serverDeps }))
    const res = await app.request('/api/workspaces/session1/documents/month/x/path', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'week/x' }),
    })
    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({ error: 'display_name_taken' })

    const listRes = await app.request('/api/workspaces/session1/documents')
    const listJson = (await listRes.json()) as { documents: { path: string }[] }
    expect(listJson.documents.map((c) => c.path).sort()).toEqual(['month/x', 'week/plan'])
  })
})
