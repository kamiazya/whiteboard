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
    await serverDeps.documentIndex.createWorkspace({ workspaceId: '013YEGSMRBDYRHT5R65KDD1H4G' })
    const withTier = createDocumentRouter(
      testDocumentRouterOptions({ serverDeps, replicaTier: async () => 'bounded' }),
    )
    expect(
      (await list(withTier)).workspaces.find((w) => w.workspaceId === '013YEGSMRBDYRHT5R65KDD1H4G')
        ?.tier,
    ).toBe('bounded')
    const without = createDocumentRouter(testDocumentRouterOptions({ serverDeps }))
    const row = (await list(without)).workspaces.find(
      (w) => w.workspaceId === '013YEGSMRBDYRHT5R65KDD1H4G',
    )
    expect(row).toBeDefined()
    expect(row && 'tier' in row).toBe(false)
  })

  it('applies the visibility filter to the listing: a workspace the caller may not see is not named', async () => {
    await serverDeps.documentIndex.createWorkspace({ workspaceId: '01R87C04DKHZX6MY9HDY04V1Q2' })
    await serverDeps.documentIndex.createWorkspace({ workspaceId: '012JBS2FW49ZCXNB6M1JT1085E' })
    const gated = createDocumentRouter(
      testDocumentRouterOptions({
        serverDeps,
        visibleWorkspaces: async () => new Set(['01R87C04DKHZX6MY9HDY04V1Q2']),
      }),
    )
    const names = (await list(gated)).workspaces.map((w) => w.workspaceId)
    expect(names).toContain('01R87C04DKHZX6MY9HDY04V1Q2')
    expect(names).not.toContain('012JBS2FW49ZCXNB6M1JT1085E')
  })
})
