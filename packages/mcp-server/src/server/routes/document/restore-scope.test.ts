import { describe, expect, it } from 'vitest'
import { createRestoreRouter } from './restore.js'

// The scope check runs before the route touches a store, so neither is
// needed to reach it; a store reached at all answers something other than
// the 403 the gate writes.
const restore = (callerScopes?: () => undefined) =>
  createRestoreRouter({
    serverDeps: {} as never,
    versionStore: {} as never,
    ...(callerScopes === undefined ? {} : { callerScopes }),
  }).request('/api/workspaces/session1/documents/canvas-a/versions/v1/restore', {
    method: 'POST',
  })

describe('restore scope gate', () => {
  it('refuses a restore that reached a wired scope seam with no recorded grant', async () => {
    // Either mode's auth middleware records a grant before this route, so
    // none recorded means the request got here some other way: fail closed.
    const res = await restore(() => undefined)
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'insufficient_scope' })
  })

  it('gates nothing on a router mounted with no scope seam', async () => {
    expect((await restore()).status).not.toBe(403)
  })
})
