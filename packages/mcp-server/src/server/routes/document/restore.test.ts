import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { Hono } from 'hono'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../_test-helpers.js'

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const tmp = withTempDataDir('whiteboard-restore-test-')

const { createRestoreRouter } = await import('./restore.js')
const { clearCache } = await import('../../store/doc-cache.js')
const { saveDocument, getDocumentKind } = await import('../../store/document-store.js')
const { createDocumentRouter } = await import('../document.js')
// Pre-load ws.js before any restore call, mirroring restore-race.test.ts's
// documented cycle workaround for document.ts's dynamic import.
await import('../ws.js')

describe('restore router', () => {
  it('returns a Hono instance', () => {
    const versionStore = { listVersions: vi.fn(), saveVersion: vi.fn() }
    const app = createRestoreRouter({ versionStore: versionStore as never })
    expect(app).toBeInstanceOf(Hono)
  })
})

// Returns [doc, updateFromEmpty] so a caller can POST the whole doc as one
// update, matching restore-race.test.ts's convention of capturing the
// version vector before any writes.
function nodesModelDocUpdate(nodeIds: string[]): Uint8Array {
  const doc = new LoroDoc()
  const vv0 = doc.version()
  writeSpatialCanvas(doc, {
    nodes: nodeIds.map((id) => ({
      id,
      type: 'text' as const,
      text: id,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    })),
    edges: [],
  })
  return doc.export({ mode: 'update', from: vv0 }) as Uint8Array
}

describe('restore router (real node counts)', () => {
  beforeEach(() => {
    clearCache()
  })

  afterEach(() => {
    clearCache()
  })

  it("restore into a brand-new targetPath responds with the past state's real node count", async () => {
    const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })

    const sourceDoc = new LoroDoc()
    const svv0 = sourceDoc.version()
    writeSpatialCanvas(sourceDoc, {
      nodes: [
        { id: 'n1', type: 'text', text: 'a', x: 0, y: 0, width: 10, height: 10 },
        { id: 'n2', type: 'text', text: 'b', x: 0, y: 0, width: 10, height: 10 },
      ],
      edges: [],
    })
    await app.request('/api/w/session1/document/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: sourceDoc.export({ mode: 'update', from: svv0 }),
    })
    const saveRes = await app.request('/api/workspaces/session1/documents/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const saveBody = (await saveRes.json()) as { version: { id: string } }

    const restoreRes = await app.request(
      `/api/workspaces/session1/documents/canvas-a/versions/${saveBody.version.id}/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPath: 'canvas-new' }),
      },
    )
    expect(restoreRes.status).toBe(200)
    const restoreBody = (await restoreRes.json()) as { documentId: string; elementCount: number }
    expect(restoreBody.elementCount).toBe(2)
  })

  it("restore-overwrite into an existing targetPath responds with the reconciled target's real node count", async () => {
    const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })

    // Source canvas with one node, saved as a version.
    await app.request('/api/w/session1/document/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: nodesModelDocUpdate(['keep-me']),
    })
    const saveRes = await app.request('/api/workspaces/session1/documents/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const saveBody = (await saveRes.json()) as { version: { id: string } }

    // Target canvas already exists with a different node.
    await app.request('/api/w/session1/document/canvas-b/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: nodesModelDocUpdate(['b-only']),
    })

    const restoreRes = await app.request(
      `/api/workspaces/session1/documents/canvas-a/versions/${saveBody.version.id}/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPath: 'canvas-b', overwrite: true }),
      },
    )
    expect(restoreRes.status).toBe(200)
    const restoreBody = (await restoreRes.json()) as { documentId: string; elementCount: number }

    // Reconcile-onto-live-doc is CRDT merge, not a straight overwrite, so
    // assert the response tracks whatever the live target doc actually
    // ended up holding rather than assuming an exact merged node set.
    const { loadDocument } = await import('../../store/document-store.js')
    const { countAliveNodes } = await import('../../store/count-alive-nodes.js')
    const finalTargetDoc = await loadDocument('session1', 'canvas-b')
    expect(restoreBody.elementCount).toBe(countAliveNodes(finalTargetDoc))
    // And it must be the real (non-zero) count, not the retired stub's 0.
    expect(restoreBody.elementCount).toBeGreaterThan(0)
  })
})

describe('restore router (kind propagation)', () => {
  beforeEach(() => {
    clearCache()
  })

  afterEach(() => {
    clearCache()
  })

  it("stamps the source's kind on a brand-new target so it opens in the right editor", async () => {
    const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })
    // A markdown document: its OKF body is a text node, so the restored
    // content alone cannot say which editor should open it.
    await saveDocument('session1', 'note-a', new LoroDoc(), { kind: 'markdown' })
    await app.request('/api/w/session1/document/note-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: nodesModelDocUpdate(['okf-body']),
    })
    const saveRes = await app.request('/api/workspaces/session1/documents/note-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const { version } = (await saveRes.json()) as { version: { id: string } }

    const restoreRes = await app.request(
      `/api/workspaces/session1/documents/note-a/versions/${version.id}/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPath: 'note-restored' }),
      },
    )
    expect(restoreRes.status).toBe(200)
    expect(await getDocumentKind('session1', 'note-restored')).toBe('markdown')
  })

  it('leaves an unrecorded kind unrecorded on the target instead of stamping spatial', async () => {
    const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })
    // The /update path creates the row without a kind, exactly as every
    // document predating kinds was created. Copying a guess here would be
    // worse than copying the gap: the target keeps it forever, and a
    // markdown document restored as spatial opens in the wrong editor.
    await app.request('/api/w/session1/document/unknown-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: nodesModelDocUpdate(['n1']),
    })
    expect(await getDocumentKind('session1', 'unknown-a')).toBeNull()

    const saveRes = await app.request('/api/workspaces/session1/documents/unknown-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const { version } = (await saveRes.json()) as { version: { id: string } }

    const restoreRes = await app.request(
      `/api/workspaces/session1/documents/unknown-a/versions/${version.id}/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPath: 'unknown-restored' }),
      },
    )
    expect(restoreRes.status).toBe(200)
    expect(await getDocumentKind('session1', 'unknown-restored')).toBeNull()
  })
})
