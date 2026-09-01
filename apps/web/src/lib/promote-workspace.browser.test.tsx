/**
 * The promotion library function over REAL IndexedDB: the browser keeper's
 * workspace record leaves through the same bytes the daemon route merges.
 * The daemon side of those bytes is pinned in mcp-server's
 * promote-workspace.test.ts; what this file adds is the browser half — the
 * record actually read from IndexedDB, and the posted snapshot verified by
 * importing it into a target record rather than by trusting the POST
 * happened.
 */
import {
  createWorkspaceDocumentAtPath,
  readWorkspaceDocuments,
  resolveWorkspaceDocumentById,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { newImageRef } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { DocumentFileStore } from './document-file-store.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'
import { ensureLocalWorkspace } from './local-document-summary.js'
import { countBrowserWorkspaceDocuments, promoteWorkspace } from './promote-workspace.js'
import { seedWorkspaceDocumentContent } from './workspace-content.js'

claimIsolatedWhiteboardDb('promote-workspace')

const BASE = 'http://127.0.0.1:3099'
const DAEMON_OWN_ID = '01DMNAAAAAAAAAAAAAAAAAAAA0'

function targetDaemonRecord(): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, {
    path: 'contested',
    documentId: DAEMON_OWN_ID,
    kind: 'markdown',
  })
  doc.commit()
  return doc
}

/**
 * A daemon standing in as three fetch routes: the update POST imports the
 * posted bytes into `target` (the verification, not a mock of it), the file
 * PUT records what arrived, and the documents list answers from the merged
 * target with the collision's loser marked shadowed — the same projection
 * the real route serves.
 */
function daemonStub(
  target: LoroDoc,
  putFiles?: Array<{ url: string; contentType: string; bytes: Uint8Array }>,
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/workspace-document/update') && init?.method === 'POST') {
      target.import(new Uint8Array(init.body as Uint8Array))
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.includes('/file/') && init?.method === 'PUT') {
      const headers = init.headers as Record<string, string>
      putFiles?.push({
        url,
        contentType: headers['Content-Type'] ?? '',
        bytes: new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer()),
      })
      return new Response(null, { status: 204 })
    }
    if (url.endsWith('/documents')) {
      const seen = new Set<string>()
      const documents = readWorkspaceDocuments(target).map((entry) => {
        const shadowed = seen.has(entry.path)
        seen.add(entry.path)
        return {
          path: entry.path,
          id: entry.documentId,
          kind: entry.kind,
          updatedAt: new Date().toISOString(),
          ...(shadowed ? { shadowed: true as const } : {}),
        }
      })
      return new Response(JSON.stringify({ documents }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof globalThis.fetch
}

describe('promoteWorkspace', () => {
  beforeEach(clearWhiteboardDb)

  it('posts the record; ids resolve on the target, the collision shadows, and referenced image bytes travel', async () => {
    const index = new FoldingBrowserIndex()
    await ensureLocalWorkspace(index)
    const roadmap = await index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'notes/roadmap',
      kind: 'markdown',
    })
    const contested = await index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'contested',
      kind: 'spatial',
    })
    // The spatial document references a stored image — its bytes live in the
    // browser's file store, OUTSIDE the record, so promotion must move them
    // through the daemon's file route.
    const imageBytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3])
    const FILE_ID = 'promoted-image-1'
    await new DocumentFileStore().put(FILE_ID, {
      mimeType: 'image/png',
      blob: new Blob([imageBytes], { type: 'image/png' }),
      created: Date.now(),
    })
    const content = new LoroDoc()
    writeSpatialCanvas(content, {
      nodes: [
        { id: 'img', type: 'file', file: newImageRef(FILE_ID), x: 0, y: 0, width: 10, height: 10 },
      ],
      edges: [],
    })
    expect(
      await seedWorkspaceDocumentContent(
        contested.documentId,
        new Uint8Array(content.export({ mode: 'snapshot' })),
      ),
    ).toBe(true)

    // The confirmation UI states the document count BEFORE promoting, from
    // the same record the transfer will read.
    expect(await countBrowserWorkspaceDocuments(new BrowserWorkspaceDocs())).toBe(2)

    const target = targetDaemonRecord()
    const putFiles: Array<{ url: string; contentType: string; bytes: Uint8Array }> = []
    const phases: string[] = []
    const result = await promoteWorkspace({
      fetch: daemonStub(target, putFiles),
      daemonBaseUrl: BASE,
      workspaceId: 'ws-a',
      workspaceDocs: new BrowserWorkspaceDocs(),
      onProgress: (phase) => phases.push(phase),
    })
    // Real progress, not staged: the record phase precedes the blob phase.
    expect(phases).toEqual(['record', 'blobs'])

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    // The per-workspace moved marker keys off this: the transfer names the
    // record it actually read, not whatever the caller believes is active.
    expect(result.sourceWorkspaceId).toBe(getBrowserWorkspaceId())
    expect([...result.promotedDocumentIds].sort()).toEqual(
      [roadmap.documentId, contested.documentId].sort(),
    )
    // Identity through the REAL posted bytes, not through the report.
    expect(resolveWorkspaceDocumentById(target, roadmap.documentId)).not.toBeNull()
    expect(resolveWorkspaceDocumentById(target, contested.documentId)).not.toBeNull()
    expect(resolveWorkspaceDocumentById(target, DAEMON_OWN_ID)).not.toBeNull()
    expect(result.shadowedPaths).toEqual(['contested'])
    // The image crossed: same bytes, right mime, addressed to the daemon's
    // file route under the owning document's path.
    expect(result.blobs).toEqual({ transferred: [FILE_ID], missing: [], failed: [] })
    expect(putFiles).toHaveLength(1)
    expect(putFiles[0]?.url).toContain(`/file/${FILE_ID}`)
    expect(putFiles[0]?.contentType).toBe('image/png')
    expect([...(putFiles[0]?.bytes ?? [])]).toEqual([...imageBytes])
  })

  it('a referenced image whose bytes are gone is reported missing, never a failed promotion', async () => {
    const index = new FoldingBrowserIndex()
    await ensureLocalWorkspace(index)
    const sketch = await index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'sketch',
      kind: 'spatial',
    })
    const content = new LoroDoc()
    writeSpatialCanvas(content, {
      nodes: [
        {
          id: 'img',
          type: 'file',
          file: newImageRef('gone-image'),
          x: 0,
          y: 0,
          width: 5,
          height: 5,
        },
      ],
      edges: [],
    })
    expect(
      await seedWorkspaceDocumentContent(
        sketch.documentId,
        new Uint8Array(content.export({ mode: 'snapshot' })),
      ),
    ).toBe(true)

    const result = await promoteWorkspace({
      fetch: daemonStub(new LoroDoc()),
      daemonBaseUrl: BASE,
      workspaceId: 'ws-a',
      workspaceDocs: new BrowserWorkspaceDocs(),
    })
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.blobs).toEqual({ transferred: [], missing: ['gone-image'], failed: [] })
  })

  it('a 404 target is a structured failure naming the missing daemon workspace', async () => {
    const index = new FoldingBrowserIndex()
    await ensureLocalWorkspace(index)
    await index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'doc',
      kind: 'markdown',
    })
    const fetch404 = (async () =>
      new Response(JSON.stringify({ title: 'Workspace "ws-gone" not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof globalThis.fetch

    const result = await promoteWorkspace({
      fetch: fetch404,
      daemonBaseUrl: BASE,
      workspaceId: 'ws-gone',
      workspaceDocs: new BrowserWorkspaceDocs(),
    })
    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') return
    expect(result.reason).toContain('not found')
  })

  it('a thrown fetch is a structured network failure, never a rejection', async () => {
    const index = new FoldingBrowserIndex()
    await ensureLocalWorkspace(index)
    await index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'doc',
      kind: 'markdown',
    })
    const fetchDown = (async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof globalThis.fetch

    const result = await promoteWorkspace({
      fetch: fetchDown,
      daemonBaseUrl: BASE,
      workspaceId: 'ws-a',
      workspaceDocs: new BrowserWorkspaceDocs(),
    })
    expect(result.kind).toBe('failed')
  })
})
