import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { resolvingDocumentIds, UNKNOWN_DOCUMENT_ID } from '../_test-helpers.js'
import { createRestoreRouter } from './restore.js'

// The scope check runs before the route touches a store, so neither is
// needed to reach it; a store reached at all answers something other than
// the 403 the gate writes. The index only has to place the id.

const restore = (callerScopes?: () => undefined) => {
  const app = new Hono()
  resolvingDocumentIds(app, { [UNKNOWN_DOCUMENT_ID]: { path: 'canvas-a' } })
  app.route(
    '/',
    createRestoreRouter({
      serverDeps: {} as never,
      versionStore: {} as never,
      ...(callerScopes === undefined ? {} : { callerScopes }),
    }),
  )
  return app.request(
    `/api/workspaces/session1/documents/${UNKNOWN_DOCUMENT_ID}/versions/v1/restore`,
    { method: 'POST' },
  )
}

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
