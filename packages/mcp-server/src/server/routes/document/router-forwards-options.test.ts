import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resolveTestServerDeps,
  testDocumentRouterOptions,
  withTempDataDir,
} from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-router-forward-')
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
const { createDocumentRouter } = await import('../document.js')

beforeEach(() => clearDocCacheForTests())
afterEach(() => clearDocCacheForTests())

type Listed = { workspaces: { workspaceId: string; tier?: string }[] }

async function list(app: ReturnType<typeof createDocumentRouter>): Promise<Listed> {
  const res = await app.request('/api/workspaces')
  return (await res.json()) as Listed
}

describe('createDocumentRouter hands its options on to the workspaces router', () => {
  it('echoes the replica tier the composition root supplied, and none when it supplied none', async () => {
    await serverDeps.documentIndex.createWorkspace({ workspaceId: 'ws-tier' })
    const withTier = createDocumentRouter(
      testDocumentRouterOptions({ serverDeps, replicaTier: async () => 'bounded' }),
    )
    expect((await list(withTier)).workspaces.find((w) => w.workspaceId === 'ws-tier')?.tier).toBe(
      'bounded',
    )
    const without = createDocumentRouter(testDocumentRouterOptions({ serverDeps }))
    const row = (await list(without)).workspaces.find((w) => w.workspaceId === 'ws-tier')
    expect(row).toBeDefined()
    expect(row && 'tier' in row).toBe(false)
  })

  it('applies the admission gate to the listing: a workspace the caller is not admitted to is not named', async () => {
    await serverDeps.documentIndex.createWorkspace({ workspaceId: 'ws-open' })
    await serverDeps.documentIndex.createWorkspace({ workspaceId: 'ws-closed' })
    const gated = createDocumentRouter(
      testDocumentRouterOptions({
        serverDeps,
        admit: async (_c, workspaceId) =>
          workspaceId === 'ws-closed' ? 'not_a_member' : 'admitted',
      }),
    )
    const names = (await list(gated)).workspaces.map((w) => w.workspaceId)
    expect(names).toContain('ws-open')
    expect(names).not.toContain('ws-closed')
  })
})
