// @vitest-environment node
/**
 * POST /api/workspaces checks that its derived segment is free before it
 * inserts, but that check is advisory: a concurrent create can take the same
 * segment between the read and the insert, and the registry's unique index is
 * what decides. The loser is a conflict the caller can retry, not a server
 * failure.
 *
 * The race is staged by hiding the existing workspace from the advisory read,
 * so the refusal comes from the real registry rather than a stubbed throw.
 */
import { isWorkspaceSegmentTakenError } from '@kamiazya/whiteboard-ports'
import { describe, expect, it, vi } from 'vitest'
import { resolveTestServerDeps, withTempDataDir } from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-workspaces-segment-race-')

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createWorkspacesRouter } = await import('./workspaces.js')

describe('POST /api/workspaces losing a segment race', () => {
  it('answers 409 with the registry refusal and creates no second row', async () => {
    const deps = await resolveTestServerDeps(tmp.dir)
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-first', segment: 'notes' })
    const before = await deps.documentIndex.listWorkspaces()
    const inner = deps.documentIndex
    let insertRefused = false
    const racing = new Proxy(inner, {
      get(target, key) {
        // The advisory read sees a registry from before the other create landed.
        if (key === 'listWorkspaces') return async () => []
        if (key === 'createWorkspace') {
          return async (...args: Parameters<typeof inner.createWorkspace>) => {
            try {
              return await inner.createWorkspace(...args)
            } catch (err) {
              insertRefused = isWorkspaceSegmentTakenError(err)
              throw err
            }
          }
        }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value
      },
    }) as typeof inner
    const app = createWorkspacesRouter({ serverDeps: { ...deps, documentIndex: racing } })

    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Notes' }),
    })

    expect(insertRefused, 'the registry never refused the insert; the race was not staged').toBe(
      true,
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ title: expect.stringContaining('notes') })
    expect(await deps.documentIndex.listWorkspaces()).toEqual(before)
  })
})
