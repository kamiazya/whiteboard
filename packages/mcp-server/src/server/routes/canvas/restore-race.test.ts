import { LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-restore-race-')

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

// Mock doc-cache so getDoc can be gated to control interleaving against a
// concurrent DELETE, mirroring canvas.test.ts's phantom-duplicate pin.
vi.mock('../../store/doc-cache.js', async () => {
  const actual = await vi.importActual<typeof import('../../store/doc-cache.js')>(
    '../../store/doc-cache.js',
  )
  return { ...actual, getDoc: vi.fn(actual.getDoc) }
})

const { clearCache, getDoc } = await import('../../store/doc-cache.js')
const { createCanvasRouter } = await import('../canvas.js')
// Pre-load ws.js before the race below. canvas.ts pulls it in via a
// fire-and-forget dynamic import (documented cycle workaround), and
// reconcileCommitSaveBroadcast() dynamically imports it again on every
// restore; racing the two first-time loads of the same circularly-
// dependent module is a separate, pre-existing module-init hazard this
// test does not intend to exercise.
await import('../ws.js')

describe('restore targetSlug-overwrite vs delete race', () => {
  beforeEach(() => {
    clearCache()
  })

  afterEach(() => {
    clearCache()
  })

  it('does not resurrect deleted content when a DELETE of the overwrite target races the restore reading it', async () => {
    const app = createCanvasRouter({ autoVersionIntervalMs: 60_000 })

    // Source canvas-a with a saved version to restore from.
    const sourceDoc = new LoroDoc()
    const svv0 = sourceDoc.version()
    const sourceList = sourceDoc.getMovableList('elements')
    const sm0 = sourceList.insertContainer(0, new LoroMap())
    sm0.set('id', 'keep-me')
    sourceDoc.commit()
    await app.request('/api/canvas/session1/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: sourceDoc.export({ mode: 'update', from: svv0 }),
    })
    const saveRes = await app.request('/api/workspaces/session1/canvases/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const saveBody = (await saveRes.json()) as { version: { id: string } }

    // Target canvas-b already exists.
    const targetDoc = new LoroDoc()
    const tvv0 = targetDoc.version()
    const targetList = targetDoc.getMovableList('elements')
    const tm0 = targetList.insertContainer(0, new LoroMap())
    tm0.set('id', 'b-only')
    targetDoc.commit()
    await app.request('/api/canvas/session1/canvas-b/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: targetDoc.export({ mode: 'update', from: tvv0 }),
    })

    // Stall the restore route's getDoc(targetSlug) call so a DELETE of the
    // target can be fired while the request is paused mid-flight, matching
    // the real race: the read resolves before the delete runs, the write
    // happens after.
    const { promise: getDocGate, resolve: releaseGetDoc } = Promise.withResolvers<void>()
    const { promise: getDocCalled, resolve: signalGetDocCalled } = Promise.withResolvers<void>()
    const actual = await vi.importActual<typeof import('../../store/doc-cache.js')>(
      '../../store/doc-cache.js',
    )
    let gateArmed = true
    vi.mocked(getDoc).mockImplementation(async (workspaceId, slug) => {
      if (gateArmed && slug === 'canvas-b') {
        gateArmed = false
        signalGetDocCalled()
        await getDocGate
      }
      return actual.getDoc(workspaceId, slug)
    })

    const restorePromise = app.request(
      `/api/workspaces/session1/canvases/canvas-a/versions/${saveBody.version.id}/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetSlug: 'canvas-b', overwrite: true }),
      },
    )

    await getDocCalled

    // Fire the delete of the overwrite target while the restore is stalled mid-flight.
    const deletePromise = app.request('/api/workspaces/session1/canvases/canvas-b', {
      method: 'DELETE',
    })
    // Give the delete a chance to run before letting the stalled read continue.
    await new Promise((r) => setTimeout(r, 20))
    releaseGetDoc()

    const [restoreRes, deleteRes] = await Promise.all([restorePromise, deletePromise])
    expect(deleteRes.status).toBe(200)
    expect(restoreRes.status).toBe(200)

    // The restore must not have silently resurrected a phantom canvas-b
    // after the delete removed it -- the delete serializes after the
    // restore's write under the workspace lock, so canvas-b must be gone.
    const listRes = await app.request('/api/workspaces/session1/canvases')
    const listJson = (await listRes.json()) as { canvases: { slug: string }[] }
    expect(listJson.canvases.map((c) => c.slug)).toEqual(['canvas-a'])
  })
})
