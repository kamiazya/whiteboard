/**
 * What a move to the daemon carries BESIDE the record, over real IndexedDB:
 * each trash entry's evacuated bytes, the saved version rows, and every image
 * a live document, a trashed one or a saved version names. The daemon's side
 * of the same body is pinned in mcp-server's workspace-promote.test.ts.
 */

import type { PromoteWorkspaceRequest } from '@kamiazya/whiteboard-daemon-client/api-contracts/promotion'
import {
  MARKDOWN_BODY_KEY,
  readTrashEntries,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { base64UrlToBytes, newImageRef } from '@kamiazya/whiteboard-model'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { jsonResponse } from '../test-utils/json-response.js'
import { seedWorkspaceDocumentContent } from '../test-utils/seed-workspace-content.js'
import { ensureBrowserWorkspace } from './browser-document-summary.js'
import { BrowserVersionStore } from './browser-version-store.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { DocumentFileStore } from './document-file-store.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'
import { IdbBlobStore } from './idb-blob-store.js'
import { promoteWorkspace } from './promote-workspace.js'

claimIsolatedWhiteboardDb('promote-workspace-carried')

const BASE = 'http://127.0.0.1:3099'

/**
 * A daemon as fetch routes. The promote POST keeps the body it was sent and
 * answers, when `confirms`, that it holds every trash entry and version the
 * body carried — what the real route reads back after storing them.
 */
function daemonStub(options: { confirms: boolean; judgedLimit?: number }) {
  const promotes: PromoteWorkspaceRequest[] = []
  const putFiles: string[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/workspace-document/promote') && init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as PromoteWorkspaceRequest
      promotes.push(body)
      if (options.judgedLimit !== undefined && promotes.length === 1) {
        return Response.json(
          { error: 'promote_too_many_carried', message: 'over', limit: options.judgedLimit },
          { status: 413 },
        )
      }
      return Response.json({
        ok: true,
        recorded: [],
        shadowed: [],
        trashStored: options.confirms ? (body.trash ?? []).map((each) => each.documentId) : [],
        versionsKept: options.confirms ? (body.versions ?? []).map((each) => each.id) : [],
      })
    }
    if (url.includes('/file/') && init?.method === 'PUT') {
      putFiles.push(url.slice(url.lastIndexOf('/file/') + '/file/'.length))
      return new Response(null, { status: 204 })
    }
    if (url.endsWith('/documents')) return jsonResponse({ documents: [] })
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof globalThis.fetch
  return { fetch, promotes, putFiles }
}

function canvasWith(nodes: Parameters<typeof writeSpatialCanvas>[1]['nodes']): Uint8Array {
  const content = new LoroDoc()
  writeSpatialCanvas(content, { nodes, edges: [] })
  return new Uint8Array(content.export({ mode: 'snapshot' }))
}

function picture(id: string) {
  return fileNode({ id: `n-${id}`, file: newImageRef(id), x: 0, y: 0, width: 10, height: 10 })
}

async function storePicture(id: string) {
  await new DocumentFileStore().put(newImageRef(id), {
    mimeType: 'image/png',
    blob: new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }),
    created: Date.now(),
  })
}

/**
 * A browser workspace with a canvas whose labelled version drew a picture
 * the canvas no longer draws, and a trashed canvas that drew another.
 */
async function seedWorkspace() {
  const index = new FoldingBrowserIndex()
  await ensureBrowserWorkspace(index)
  const workspaceId = getBrowserWorkspaceId()
  const docs = new BrowserWorkspaceDocs()
  const sketch = await index.createDocument({ workspaceId, path: 'sketch', kind: 'spatial' })
  const gone = await index.createDocument({ workspaceId, path: 'gone', kind: 'spatial' })
  await storePicture('only-in-a-version')
  await storePicture('only-in-the-trash')
  expect(
    await seedWorkspaceDocumentContent(
      sketch.documentId,
      canvasWith([picture('only-in-a-version')]),
    ),
  ).toBe(true)
  expect(
    await seedWorkspaceDocumentContent(gone.documentId, canvasWith([picture('only-in-the-trash')])),
  ).toBe(true)
  const drafted = await new BrowserVersionStore({ docs, index }).save(workspaceId, 'sketch', {
    label: 'as drafted',
    operator: { kind: 'human', displayName: 'Yuki' },
  })
  const plain = textNode({ id: 't', x: 0, y: 0, width: 80, height: 40, text: 'redrawn' })
  expect(await seedWorkspaceDocumentContent(sketch.documentId, canvasWith([plain]))).toBe(true)
  await index.deleteDocument({ workspaceId, path: 'gone' })
  return { sketch, gone, drafted }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

describe('promoteWorkspace, what travels beside the record', () => {
  beforeEach(clearWhiteboardDb)

  it('carries each trash entry under its digest and each saved version, label kept, leaving nothing', async () => {
    const { gone, sketch, drafted } = await seedWorkspace()
    const daemon = daemonStub({ confirms: true })
    const result = await promoteWorkspace({
      fetch: daemon.fetch,
      keeperBaseUrl: BASE,
      workspaceId: 'ws-a',
      workspaceDocs: new BrowserWorkspaceDocs(),
    })
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.leftBehind).toEqual([])

    const [body] = daemon.promotes
    expect(body?.trash?.map((each) => each.documentId)).toEqual([gone.documentId])
    const record = await new BrowserWorkspaceDocs().open(getBrowserWorkspaceId())
    const entry = record === null ? undefined : readTrashEntries(record)[0]
    const carried = base64UrlToBytes(body?.trash?.[0]?.bytes ?? '')
    expect(carried === null ? null : await sha256Hex(carried)).toBe(entry?.blob.digestHex)

    expect(body?.versions).toEqual([
      expect.objectContaining({
        id: drafted.id,
        documentId: sketch.documentId,
        label: 'as drafted',
        auto: false,
        operator: { kind: 'human', displayName: 'Yuki' },
      }),
    ])
  })

  it('uploads an image only a trashed document names, and one only a saved version names', async () => {
    await seedWorkspace()
    const daemon = daemonStub({ confirms: true })
    const result = await promoteWorkspace({
      fetch: daemon.fetch,
      keeperBaseUrl: BASE,
      workspaceId: 'ws-a',
      workspaceDocs: new BrowserWorkspaceDocs(),
    })
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect([...result.blobs.transferred].sort()).toEqual(['only-in-a-version', 'only-in-the-trash'])
    expect([...daemon.putFiles].sort()).toEqual(['only-in-a-version', 'only-in-the-trash'])
  })

  it('names what the daemon did not confirm holding, so the browser copy stays', async () => {
    await seedWorkspace()
    const result = await promoteWorkspace({
      fetch: daemonStub({ confirms: false }).fetch,
      keeperBaseUrl: BASE,
      workspaceId: 'ws-a',
      workspaceDocs: new BrowserWorkspaceDocs(),
    })
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.leftBehind).toEqual([
      '1 trashed document did not reach the daemon',
      '1 saved version did not reach the daemon',
    ])
  })

  it('leaves a trash entry whose bytes are gone behind, named, and sends no bytes for it', async () => {
    await seedWorkspace()
    const record = await new BrowserWorkspaceDocs().open(getBrowserWorkspaceId())
    const entry = record === null ? undefined : readTrashEntries(record)[0]
    if (entry === undefined) throw new Error('no trash entry')
    await new IdbBlobStore().delete({ ref: entry.blob })
    const daemon = daemonStub({ confirms: true })
    const result = await promoteWorkspace({
      fetch: daemon.fetch,
      keeperBaseUrl: BASE,
      workspaceId: 'ws-a',
      workspaceDocs: new BrowserWorkspaceDocs(),
    })
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(daemon.promotes[0]?.trash).toBeUndefined()
    expect(result.leftBehind).toEqual([
      'the trashed document "gone" cannot be read in this browser',
    ])
  })

  it('re-sends without the saved versions past the daemon check budget, counting them', async () => {
    const index = new FoldingBrowserIndex()
    await ensureBrowserWorkspace(index)
    const workspaceId = getBrowserWorkspaceId()
    const note = await index.createDocument({ workspaceId, path: 'note', kind: 'markdown' })
    const body = new LoroDoc()
    body.getText(MARKDOWN_BODY_KEY).insert(0, 'a long enough body')
    body.commit()
    const bytes = new Uint8Array(body.export({ mode: 'snapshot' }))
    expect(await seedWorkspaceDocumentContent(note.documentId, bytes)).toBe(true)
    const docs = new BrowserWorkspaceDocs()
    await new BrowserVersionStore({ docs, index }).save(workspaceId, 'note', { label: 'one' })
    const daemon = daemonStub({ confirms: true, judgedLimit: 1 })
    const result = await promoteWorkspace({
      fetch: daemon.fetch,
      keeperBaseUrl: BASE,
      workspaceId: 'ws-a',
      workspaceDocs: new BrowserWorkspaceDocs(),
    })
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(daemon.promotes).toHaveLength(2)
    expect(daemon.promotes[0]?.versions).toHaveLength(1)
    expect(daemon.promotes[1]?.versions).toBeUndefined()
    expect(result.versionsLeftBehind).toBe(1)
    expect(result.leftBehind).toEqual([
      '1 older saved version: checking more would take the daemon longer than one move allows',
    ])
  })
})
