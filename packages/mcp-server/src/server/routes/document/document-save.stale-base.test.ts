/**
 * What a document tool's save does when the record moved after the tool loaded
 * the document: the stored bytes are cut from the record (`loadSnapshot`), the
 * tool edits its own copy, and the save (`saveSnapshot`) writes that copy back
 * through the record. Another writer's edit that landed in between is either
 * kept beside the tool's or lost to it, and this pins which, for a canvas (a
 * map keyed by id) and a note (a text with concurrent inserts). The canvas
 * merges; the note keeps the other writer's insert and also doubles the text
 * both sides started from.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readMarkdownBody,
  readSpatialCanvas,
  resolveWorkspaceDocument,
  writeMarkdownBody,
  writeSpatialNode,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import {
  chunkSnapshot,
  DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES,
  reassembleSnapshot,
} from '@kamiazya/whiteboard-ports'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  documentIdAt,
  postDocumentEdit,
  resolveTestServerDeps,
  testDocumentRouterOptions,
  withTempDataDir,
} from '../_test-helpers.js'

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const tmp = withTempDataDir('whiteboard-stale-save-test-')
const WS = '01M8BBN7JS60N0ZAR13NP8SXBF'

let serverDeps: ServerDeps
beforeEach(async () => {
  serverDeps = await resolveTestServerDeps(tmp.dir)
  await serverDeps.documentIndex.createWorkspace({ workspaceId: WS })
})

const { createDocumentRouter } = await import('../document.js')
await import('../../sync-audience.js')

const box = (id: string) => textNode({ id, text: id, x: 0, y: 0, width: 10, height: 10 })

/** A record holding one document each of the two kinds, with content a tool then edits. */
async function seededApp() {
  const app = createDocumentRouter(
    testDocumentRouterOptions({ serverDeps, autoVersionQuietMs: 60_000 }),
  )
  const base = `/api/w/${WS}/workspace-document`
  const snapshot = await app.request(`${base}/snapshot`)
  const replica = LoroDoc.fromSnapshot(new Uint8Array(await snapshot.arrayBuffer()))
  const from = replica.oplogVersion()
  createWorkspaceDocumentAtPath(replica, {
    path: 'board',
    documentId: '01BRWAAAAAAAAAAAAAAAAAAAA1',
    kind: 'spatial',
  })
  createWorkspaceDocumentAtPath(replica, {
    path: 'note',
    documentId: '01BRWAAAAAAAAAAAAAAAAAAAA2',
    kind: 'markdown',
  })
  writeSpatialNode(documentContainers(replica, '01BRWAAAAAAAAAAAAAAAAAAAA1'), box('base'))
  writeMarkdownBody(documentContainers(replica, '01BRWAAAAAAAAAAAAAAAAAAAA2'), 'middle')
  replica.commit()
  const res = await app.request(`${base}/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: replica.export({ mode: 'update', from }) as Uint8Array<ArrayBuffer>,
  })
  expect(res.status).toBe(200)
  return app
}

// Where each tool copy was loaded, as the tool's session keeps it: handed back
// on the first save, and gone once the copy has been saved.
const loadedAt = new WeakMap<LoroDoc, Uint8Array>()

async function loadFor(documentId: string): Promise<LoroDoc> {
  const loaded = await serverDeps.documentStore.loadSnapshot({
    docRef: { kind: 'document', workspaceId: WS, documentId },
  })
  if (loaded === null) throw new Error('no stored document')
  const copy = LoroDoc.fromSnapshot(reassembleSnapshot(loaded.manifest, loaded.chunks))
  loadedAt.set(copy, loaded.frontier)
  return copy
}

async function saveFrom(documentId: string, doc: LoroDoc): Promise<void> {
  const { manifest, chunks } = chunkSnapshot(
    new Uint8Array(doc.export({ mode: 'snapshot' })),
    DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES,
  )
  await serverDeps.documentStore.saveSnapshot({
    docRef: { kind: 'document', workspaceId: WS, documentId },
    manifest,
    chunks,
    frontier: new Uint8Array(doc.oplogVersion().encode()),
    ...(loadedAt.has(doc) ? { basedOn: loadedAt.get(doc) as Uint8Array<ArrayBuffer> } : {}),
  })
  loadedAt.delete(doc)
}

async function recordOf(app: Awaited<ReturnType<typeof seededApp>>): Promise<LoroDoc> {
  const snapshot = await app.request(`/api/w/${WS}/workspace-document/snapshot`)
  return LoroDoc.fromSnapshot(new Uint8Array(await snapshot.arrayBuffer()))
}

describe('a tool save over a record that moved since the tool loaded', () => {
  it('keeps another writer’s canvas node beside the tool’s', async () => {
    const app = await seededApp()
    const documentId = await documentIdAt(serverDeps, WS, 'board')
    const toolsCopy = await loadFor(documentId)
    await postDocumentEdit(app, WS, 'board', (containers) =>
      writeSpatialNode(containers, box('theirs')),
    )
    writeSpatialNode(toolsCopy, box('tool'))
    toolsCopy.commit()
    await saveFrom(documentId, toolsCopy)
    const record = await recordOf(app)
    const entry = resolveWorkspaceDocument(record, 'board')
    const ids = readSpatialCanvas(documentContainers(record, entry?.documentId ?? ''))
      .nodes.map((node) => node.id)
      .sort()
    expect(ids).toEqual(['base', 'theirs', 'tool'])
  })

  // Recorded, not endorsed: the tool's copy and the record's re-cut projection each hold their own
  // insert of the shared text, so merging them keeps both.
  it('keeps both the tool’s and the record’s copy of a note’s shared text when another writer inserted beside it', async () => {
    const app = await seededApp()
    const documentId = await documentIdAt(serverDeps, WS, 'note')
    const toolsCopy = await loadFor(documentId)
    await postDocumentEdit(app, WS, 'note', (containers) => {
      const body = containers.getText('body')
      body.insert(body.length, ' theirs')
    })
    const mine = toolsCopy.getText('body')
    mine.insert(0, 'tool ')
    toolsCopy.commit()
    await saveFrom(documentId, toolsCopy)
    const record = await recordOf(app)
    const entry = resolveWorkspaceDocument(record, 'note')
    const body = readMarkdownBody(documentContainers(record, entry?.documentId ?? ''))
    // Where the concurrent inserts fall depends on the peers' ids, so only what the body holds is pinned.
    expect(body.split('middle')).toHaveLength(3)
    expect(body.split('tool')).toHaveLength(2)
    expect(body.split('theirs')).toHaveLength(2)
  })
})

describe('a tool save over a record that did not move since the tool loaded', () => {
  it('ends a canvas with each node once', async () => {
    const app = await seededApp()
    const documentId = await documentIdAt(serverDeps, WS, 'board')
    const toolsCopy = await loadFor(documentId)
    writeSpatialNode(toolsCopy, box('tool'))
    toolsCopy.commit()
    await saveFrom(documentId, toolsCopy)
    const record = await recordOf(app)
    const entry = resolveWorkspaceDocument(record, 'board')
    const ids = readSpatialCanvas(documentContainers(record, entry?.documentId ?? ''))
      .nodes.map((node) => node.id)
      .sort()
    expect(ids).toEqual(['base', 'tool'])
  })

  it('ends a note with its text once, the tool’s insert in place', async () => {
    const app = await seededApp()
    const documentId = await documentIdAt(serverDeps, WS, 'note')
    const toolsCopy = await loadFor(documentId)
    toolsCopy.getText('body').insert(0, 'tool ')
    toolsCopy.commit()
    await saveFrom(documentId, toolsCopy)
    const record = await recordOf(app)
    const entry = resolveWorkspaceDocument(record, 'note')
    expect(readMarkdownBody(documentContainers(record, entry?.documentId ?? ''))).toBe(
      'tool middle',
    )
  })

  it('does the same on a second save of the same copy, still once', async () => {
    const app = await seededApp()
    const documentId = await documentIdAt(serverDeps, WS, 'note')
    const toolsCopy = await loadFor(documentId)
    toolsCopy.getText('body').insert(0, 'a ')
    toolsCopy.commit()
    await saveFrom(documentId, toolsCopy)
    toolsCopy.getText('body').insert(0, 'b ')
    toolsCopy.commit()
    await saveFrom(documentId, toolsCopy)
    const record = await recordOf(app)
    const entry = resolveWorkspaceDocument(record, 'note')
    expect(readMarkdownBody(documentContainers(record, entry?.documentId ?? ''))).toBe('b a middle')
  })
})
