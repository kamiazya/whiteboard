import {
  readAnnotations,
  readDocumentKind,
  readFacets,
  readMarkdownBody,
  readNodeLocks,
  readSpatialCanvasWithSkipped,
  setNodeLock,
  sharedCrdtEngine,
  writeCommentThread,
  writeDocumentKind,
  writeFacets,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { MARKDOWN_MAX_CHARS, type documentEngine as wire } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { reassembleSnapshot, type SaveSnapshotInput } from '@kamiazya/whiteboard-ports'
import { LoroDoc, VersionVector } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentEngineTrapError } from './document-io.js'
import { openDocument, withDocument } from './document-session.js'
import { setLogSink } from './log.js'
import type { DocumentWritten } from './server-deps.js'
import { FakeDocumentStore, seedDoc } from './test-utils/fake-document-store.js'
import { makeTestDeps } from './test-utils/make-test-deps.js'

const WORKSPACE_ID = '01ZVM89A4A1V9FS03Z9J64KEK1'
const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'

class RecordingStore extends FakeDocumentStore {
  readonly saved: SaveSnapshotInput[] = []
  override async saveSnapshot(input: SaveSnapshotInput): Promise<void> {
    this.saved.push(input)
    await super.saveSnapshot(input)
  }
}

function rig() {
  const store = new RecordingStore()
  const written: Parameters<DocumentWritten>[0][] = []
  const deps = makeTestDeps({
    documentStore: store,
    documentIndex: store.documentIndex,
    documentWritten: async (event) => {
      written.push(event)
    },
  })
  return { store, deps, written }
}

const board = (doc: LoroDoc) => {
  writeDocumentKind(doc, 'spatial')
  writeSpatialCanvas(doc, {
    nodes: [textNode({ id: 'n1', x: 1, y: 2, width: 100, height: 50, text: 'hello' })],
    edges: [],
  })
}

const THREAD = {
  id: 't1',
  anchor: { kind: 'document' },
  status: 'open',
  createdAt: '2026-01-01T00:00:00.000Z',
  messages: [{ id: 't1-m1', body: 'hi', createdAt: '2026-01-01T00:00:00.000Z' }],
} as const

/** The batch below and the direct writers that make the same changes. */
const BATCH: wire.Write[] = [
  { op: 'writeMarkdownBody', args: { body: 'written through the session' } },
  { op: 'writeFacets', args: { facets: { 'visual.theme/v0': { theme: 'visual.sketch' } } } },
  { op: 'writeCommentThread', args: { thread: THREAD } },
  { op: 'setNodeLock', args: { id: 'n1', locked: true } },
]
const writeDirectly = (doc: LoroDoc) => {
  writeMarkdownBody(doc, 'written through the session')
  writeFacets(doc, { 'visual.theme/v0': { theme: 'visual.sketch' } })
  writeCommentThread(doc, { ...THREAD, anchor: { kind: 'document' } } as never)
  setNodeLock(doc, 'n1', true)
}

async function stored(store: FakeDocumentStore): Promise<LoroDoc> {
  const saved = await store.loadSnapshot({
    docRef: { kind: 'document', workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID },
  })
  if (saved === null) throw new Error('nothing saved')
  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(saved.manifest, saved.chunks))
  return doc
}

const contentOf = (doc: LoroDoc) => ({
  kind: readDocumentKind(doc),
  body: readMarkdownBody(doc),
  canvas: readSpatialCanvasWithSkipped(doc),
  facets: readFacets(doc),
  threads: readAnnotations(doc),
  locks: [...readNodeLocks(doc)],
})

afterEach(() => {
  vi.restoreAllMocks()
  setLogSink(() => {})
})

describe('writing through a document session', () => {
  it('stores what the direct writers store for the same changes', async () => {
    const { store, deps } = rig()
    await seedDoc(store, DOCUMENT_ID, board)
    const direct = new LoroDoc()
    board(direct)
    writeDirectly(direct)

    await withDocument(deps, WORKSPACE_ID, DOCUMENT_ID, async (session) => {
      session.write(BATCH)
      await session.save()
    })

    expect(contentOf(await stored(store))).toEqual(contentOf(direct))
  })

  it('saves nothing when a write throws, and stores what was stored before', async () => {
    const { store, deps, written } = rig()
    await seedDoc(store, DOCUMENT_ID, board)
    store.saved.length = 0
    const before = contentOf(await stored(store))
    const refused: wire.Write = {
      op: 'writeCommentThread',
      args: { thread: { ...THREAD, anchor: { kind: 'spatial', x: Number.NaN, y: 0 } } },
    }

    await expect(
      withDocument(deps, WORKSPACE_ID, DOCUMENT_ID, async (session) => {
        session.write([BATCH[0] as wire.Write, refused])
        await session.save()
      }),
    ).rejects.toThrow(/non-finite/)

    expect(store.saved).toEqual([])
    expect(written).toEqual([])
    expect(contentOf(await stored(store))).toEqual(before)
  })

  it('does not judge a write against the sync limits, as the direct writers were not', async () => {
    const { store, deps } = rig()
    await seedDoc(store, DOCUMENT_ID, board)
    const longBody = 'x'.repeat(MARKDOWN_MAX_CHARS + 1)

    await withDocument(deps, WORKSPACE_ID, DOCUMENT_ID, async (session) => {
      session.write([{ op: 'writeMarkdownBody', args: { body: longBody } }])
      await session.save()
    })

    expect(readMarkdownBody(await stored(store))).toBe(longBody)
  })

  it('keeps the writes of one batch visible to the reads that follow it', async () => {
    const { store, deps } = rig()
    await seedDoc(store, DOCUMENT_ID, board)
    await withDocument(deps, WORKSPACE_ID, DOCUMENT_ID, async (session) => {
      session.write([BATCH[0] as wire.Write])
      expect(await session.read({ query: 'markdownBody' }, { parse: String })).toBe(
        'written through the session',
      )
    })
  })

  it('saves the frontier of the bytes it saves, in the encoding the stores read', async () => {
    const { store, deps } = rig()
    await seedDoc(store, DOCUMENT_ID, board)
    store.saved.length = 0
    await withDocument(deps, WORKSPACE_ID, DOCUMENT_ID, async (session) => {
      session.write(BATCH)
      await session.save()
    })

    expect(store.saved).toHaveLength(1)
    const [save] = store.saved
    const carried = await stored(store)
    expect(VersionVector.decode(save?.frontier as Uint8Array).compare(carried.oplogVersion())).toBe(
      0,
    )
    expect(save?.manifest).toBeDefined()
  })

  it('announces each save once, with the saved content as a LoroDoc and the placement', async () => {
    const { store, deps, written } = rig()
    await seedDoc(store, DOCUMENT_ID, board)
    store.documentIndex.seed({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      path: 'where',
      kind: 'spatial',
    })

    await withDocument(deps, WORKSPACE_ID, DOCUMENT_ID, async (session) => {
      session.write(BATCH)
      await session.save()
      expect(written).toHaveLength(1)
      session.write([{ op: 'setNodeLock', args: { id: 'n1', locked: false } }])
      await session.save()
    })

    expect(written).toHaveLength(2)
    const [first, second] = written
    expect(Object.keys(first ?? {}).sort()).toEqual(['doc', 'documentId', 'path', 'workspaceId'])
    expect(first).toMatchObject({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      path: 'where',
    })
    expect(readNodeLocks(first?.doc as LoroDoc).has('n1')).toBe(true)
    expect(readNodeLocks(second?.doc as LoroDoc).has('n1')).toBe(false)
    expect(contentOf(second?.doc as LoroDoc)).toEqual(contentOf(await stored(store)))
  })

  it('does not undo a save when the observer throws', async () => {
    const { store, deps } = rig()
    await seedDoc(store, DOCUMENT_ID, board)
    const failing = { ...deps, documentWritten: async () => Promise.reject(new Error('observer')) }
    await withDocument(failing, WORKSPACE_ID, DOCUMENT_ID, async (session) => {
      session.write(BATCH)
      await session.save()
    })
    expect(readMarkdownBody(await stored(store))).toBe('written through the session')
  })

  it('reports an engine abort while saving, as a save of that document', async () => {
    const { store, deps } = rig()
    await seedDoc(store, DOCUMENT_ID, board)
    store.saved.length = 0
    const session = await openDocument(deps, WORKSPACE_ID, DOCUMENT_ID)
    try {
      vi.spyOn(sharedCrdtEngine(), 'export').mockImplementation(() => {
        throw new WebAssembly.RuntimeError('unreachable')
      })
      await expect(session.save()).rejects.toBeInstanceOf(DocumentEngineTrapError)
    } finally {
      session.release()
    }
    expect(store.saved).toEqual([])
  })

  it('gives its handle back after a save and after a failed write', async () => {
    const { store, deps } = rig()
    await seedDoc(store, DOCUMENT_ID, board)
    const engine = sharedCrdtEngine()
    const open = vi.spyOn(engine, 'open')
    const close = vi.spyOn(engine, 'close')
    await withDocument(deps, WORKSPACE_ID, DOCUMENT_ID, async (session) => {
      session.write(BATCH)
      await session.save()
    })
    await expect(
      withDocument(deps, WORKSPACE_ID, DOCUMENT_ID, (session) =>
        session.write([{ op: 'writeCommentThread', args: { thread: { id: 'x' } } }]),
      ),
    ).rejects.toThrow()
    const minted = open.mock.results.map((r) => (r.value as { handle: number }).handle)
    const closed = close.mock.calls.map(([request]) => request.handle)
    expect(minted).toHaveLength(2)
    for (const handle of minted) expect(closed.filter((c) => c === handle)).toHaveLength(1)
  })
})
