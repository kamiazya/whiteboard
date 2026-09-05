import type { VersionEntry } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import {
  projectWorkspaceDocument,
  readSpatialCanvas,
  writeSpatialCanvas,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { describe } from 'vitest'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BrowserBackend } from './browser-backend.js'
import { BrowserVersionStore } from './browser-version-store.js'
import { createBrowserVersionsBackend } from './browser-versions-backend.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'
import {
  type VersionsBackendHarness,
  versionsBackendContract,
} from './versions-backend.contract.js'
import { createDaemonVersionsBackend } from './versions-backend.js'

const ISOLATED_DB = claimIsolatedWhiteboardDb('versionsbackendcontract')

function textDoc(text: string): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 80, height: 40, text }],
    edges: [],
  })
  doc.commit()
  return doc
}

function textOf(doc: LoroDoc | null): string | undefined {
  if (doc === null) return undefined
  const node = readSpatialCanvas(doc).nodes[0]
  return node?.type === 'text' ? node.text : undefined
}

function clearDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(ISOLATED_DB)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

/**
 * The browser keeper, end to end: a real IndexedDB record, the real store,
 * the real backend that reconciles a restore onto it.
 */
async function browserHarness(): Promise<VersionsBackendHarness> {
  await clearDb()
  const workspaceId = getBrowserWorkspaceId()
  const index = new FoldingBrowserIndex()
  await index.createWorkspace({ workspaceId })
  const { documentId } = await index.createDocument({
    workspaceId,
    path: 'canvas-a',
    kind: 'spatial',
  })
  const other = await index.createDocument({ workspaceId, path: 'canvas-b', kind: 'spatial' })

  const docs = new BrowserWorkspaceDocs()
  const store = new BrowserVersionStore({ docs, index })
  const backend = new BrowserBackend({ documentId, path: 'canvas-a', kind: 'spatial' }, docs)

  // The restore path reconciles onto the record the BACKEND holds and
  // delivers the result through the sync session's handlers, so the backend
  // has to be connected for a restore to have anywhere to land — and its
  // live record has to be current.
  const connect = async (): Promise<void> => {
    backend.connect({
      onSnapshot: () => {},
      onRemoteUpdate: () => {},
      onConnected: () => {},
      onDisconnected: () => {},
      // The restore brackets itself with these; a stub that omits them fails
      // inside the backend rather than in a contract case.
      onRestoreStarted: () => {},
      onRestoreComplete: () => {},
      onVersionCreated: () => {},
      onHeadChanged: () => {},
      onViewportRequest: () => {},
      onExportRequest: () => {},
    })
    await new Promise((r) => setTimeout(r, 50))
  }
  await connect()

  const write = async (text: string, id = documentId): Promise<void> => {
    const record = await docs.open(workspaceId)
    if (record === null) throw new Error('no workspace record')
    writeWorkspaceDocumentContent(record, id, textDoc(text))
    await docs.save(workspaceId, record)
    // Re-read into the backend, because this harness writes the record
    // DIRECTLY rather than through `pushLocalUpdate`. In the app the two
    // cannot drift — every edit goes through the backend, which is what
    // keeps its live record and the store in step — so a harness that wrote
    // behind its back would be testing a state the keeper never reaches,
    // and would report a restore onto a stale record as a keeper defect.
    backend.disconnect()
    await connect()
  }

  return {
    backend: createBrowserVersionsBackend({ store, backend }),
    workspaceId,
    path: 'canvas-a',
    write,
    async read() {
      const record = await docs.open(workspaceId)
      return textOf(record === null ? null : projectWorkspaceDocument(record, documentId))
    },
    async foreignVersionId() {
      await write('another document', other.documentId)
      const entry = await store.save(workspaceId, 'canvas-b', {})
      return entry.id
    },
    async cleanup() {
      backend.disconnect()
      await clearDb()
    },
  }
}

/**
 * The daemon keeper's CLIENT, against an in-memory stand-in for its routes.
 *
 * What this proves and what it does not, said plainly. The daemon's real
 * behaviour — that a restore reconciles, that the store refuses another
 * document's id, that pruning spares lineage — is pinned where it lives, in
 * `mcp-node`, against the real routes and the real SQLite. Repeating it here
 * would only assert that this file's stand-in does what this file's stand-in
 * does. What is untested anywhere else, and is exactly what this run adds, is
 * that the CLIENT half of the seam translates faithfully: that `save` sends
 * the label and reads the row back out of the response, that `restore` posts
 * where it should, that `loadPast` turns a 404 into `null` rather than a
 * throw. Those are all things a keeper can get wrong on its own.
 */
function daemonHarness(): VersionsBackendHarness {
  const versions: VersionEntry[] = []
  const content = new Map<string, string>()
  const thumbnails = new Map<string, Blob>()
  let current = ''
  let seq = 0
  const OTHER = 'v-belongs-to-another-document'

  const routes = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })

    const thumbnail = url.match(/\/versions\/([^/]+)\/thumbnail$/)
    if (thumbnail) {
      const id = thumbnail[1] as string
      if (init?.method === 'PUT') {
        if (!content.has(id)) return new Response('{}', { status: 404 })
        thumbnails.set(id, new Blob([init.body as BlobPart], { type: 'image/png' }))
        const row = versions.find((v) => v.id === id)
        if (row !== undefined) versions[versions.indexOf(row)] = { ...row, hasThumbnail: true }
        return json({ ok: true })
      }
      // The route establishes ownership before it reads bytes, so a version
      // another document owns is answered as absent — see thumbnails.ts.
      if (id === OTHER) return new Response('{}', { status: 404 })
      const blob = thumbnails.get(id)
      // 204, the way the daemon answers a point that has no picture yet.
      if (blob === undefined) return new Response(null, { status: 204 })
      return new Response(blob, { status: 200, headers: { 'Content-Type': 'image/png' } })
    }

    const restore = url.match(/\/versions\/([^/]+)\/restore$/)
    if (restore && init?.method === 'POST') {
      const id = restore[1] as string
      const past = content.get(id)
      if (past === undefined) return new Response('{}', { status: 404 })
      current = past
      // The merge point the operation records; see restore-version.ts.
      versions.unshift(entry(`v-restore-${++seq}`, undefined, id))
      content.set(`v-restore-${seq}`, current)
      return json({ ok: true })
    }

    const document = url.match(/\/versions\/([^/]+)\/document$/)
    if (document) {
      const id = document[1] as string
      // The refusal: an id alone must not read another document's history.
      if (id === OTHER || !content.has(id)) return new Response('{}', { status: 404 })
      return json({
        kind: 'spatial',
        canvas: {
          nodes: [
            { id: 'n1', type: 'text', x: 0, y: 0, width: 80, height: 40, text: content.get(id) },
          ],
          edges: [],
        },
      })
    }

    if (url.endsWith('/versions') && init?.method === 'POST') {
      const label = JSON.parse(String(init.body ?? '{}')).label as string | undefined
      const created = entry(`v-${++seq}`, label)
      versions.unshift(created)
      content.set(created.id, current)
      return json({ version: created })
    }

    if (url.endsWith('/versions')) return json({ versions })
    return json({})
  }

  const entry = (id: string, label?: string, restoredFrom?: string): VersionEntry => ({
    id,
    path: 'canvas-a',
    createdAt: new Date(Date.now() + seq).toISOString(),
    elementCount: 1,
    auto: restoredFrom !== undefined,
    hasThumbnail: false,
    branchName: 'main',
    ...(label === undefined || label === '' ? {} : { label }),
    ...(restoredFrom === undefined ? {} : { restoredFrom }),
  })

  return {
    backend: createDaemonVersionsBackend(routes as typeof globalThis.fetch),
    workspaceId: 'ws-1',
    path: 'canvas-a',
    async write(text) {
      current = text
    },
    async read() {
      return current
    },
    async foreignVersionId() {
      return OTHER
    },
    async cleanup() {},
  }
}

describe('VersionsBackend contract — browser keeper (real IndexedDB)', () => {
  versionsBackendContract(browserHarness)
})

describe('VersionsBackend contract — daemon keeper (client over stand-in routes)', () => {
  versionsBackendContract(daemonHarness)
})
