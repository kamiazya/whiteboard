import {
  readAnnotations,
  readCoreFacets,
  readContentWithTags,
  readDocumentKind,
  readFacets,
  readMarkdownBody,
  readProposals,
  readSpatialCanvasWithSkipped,
  readTrustFacets,
  sharedCrdtEngine,
  writeCoreFacets,
  writeDocumentKind,
  writeFacets,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { type LoadSnapshotInput, reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { InMemoryDocumentStore } from '@kamiazya/whiteboard-ports/test-utils'
import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentEngineTrapError, SnapshotNotFoundError } from './document-io.js'
import { openDocument, openOrCreateDocument, withDocument } from './document-session.js'
import {
  annotationsOf,
  canvasOf,
  contentOf,
  coreFacetsOf,
  facetsOf,
  kindOf,
  markdownBodyOf,
  proposalsOf,
  trustFacetsOf,
} from './document-session-reads.js'
import { setLogSink } from './log.js'
import { FakeDocumentStore, seedDoc } from './test-utils/fake-document-store.js'
import { makeTestDeps } from './test-utils/make-test-deps.js'

const WORKSPACE_ID = '01ZVM89A4A1V9FS03Z9J64KEK1'
const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'

const deps = (documentStore: FakeDocumentStore) => makeTestDeps({ documentStore })

/** Every handle the shared engine mints while a test runs, and which of them were closed exactly once. */
function watchEngineHandles() {
  const engine = sharedCrdtEngine()
  const open = vi.spyOn(engine, 'open')
  const close = vi.spyOn(engine, 'close')
  const minted = () =>
    open.mock.results.flatMap((result) =>
      result.type === 'return' ? [(result.value as { handle: number }).handle] : [],
    )
  return {
    minted,
    unaccounted: () => {
      const closed = close.mock.calls.map(([request]) => request.handle)
      return minted().filter((handle) => closed.filter((c) => c === handle).length !== 1)
    },
  }
}

const spatial = (doc: LoroDoc) => {
  writeDocumentKind(doc, 'spatial')
  writeSpatialCanvas(doc, {
    nodes: [textNode({ id: 'n1', x: 1, y: 2, width: 100, height: 50, text: 'hello' })],
    edges: [],
  })
  writeFacets(doc, { 'visual.theme/v0': { theme: 'visual.sketch' } })
}

const markdown = (doc: LoroDoc) => {
  writeDocumentKind(doc, 'markdown')
  writeMarkdownBody(doc, '# Title\n\nbody text')
  writeCoreFacets(doc, { description: 'about it', tags: ['a', 'b'] })
}

afterEach(() => {
  vi.restoreAllMocks()
  setLogSink(() => {})
})

describe('a document session over a stored snapshot', () => {
  it('answers a canvas the way the adapter reads the same bytes', async () => {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, spatial)
    const stored = await seededDoc(store)

    const session = await openDocument(deps(store), WORKSPACE_ID, DOCUMENT_ID)
    try {
      expect(await canvasOf(session)).toEqual(readSpatialCanvasWithSkipped(stored).canvas)
      expect(await kindOf(session)).toBe(readDocumentKind(stored))
      expect(await facetsOf(session)).toEqual(readFacets(stored))
      expect(await annotationsOf(session)).toEqual(readAnnotations(stored))
      expect(await proposalsOf(session)).toEqual(readProposals(stored))
      expect(await coreFacetsOf(session)).toEqual(readCoreFacets(stored))
      expect(await trustFacetsOf(session)).toEqual(readTrustFacets(stored))
      expect(await contentOf(session, undefined)).toEqual(readContentWithTags(stored, undefined))
    } finally {
      session.release()
    }
  })

  it('answers a markdown document the way the adapter reads the same bytes', async () => {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, markdown)
    const stored = await seededDoc(store)

    await withDocument(deps(store), WORKSPACE_ID, DOCUMENT_ID, async (session) => {
      expect(await markdownBodyOf(session)).toBe(readMarkdownBody(stored))
      expect(await coreFacetsOf(session)).toEqual(readCoreFacets(stored))
      expect(await contentOf(session, undefined)).toEqual(readContentWithTags(stored, undefined))
    })
  })

  it('answers the kind the index records for a document that stored none', async () => {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => writeMarkdownBody(doc, 'untyped'))

    await withDocument(deps(store), WORKSPACE_ID, DOCUMENT_ID, async (session) => {
      expect(await kindOf(session)).toBeUndefined()
      expect(await contentOf(session, 'markdown')).toMatchObject({
        content: { kind: 'markdown', body: 'untyped' },
      })
    })
  })

  it('keeps a stored field a strict reader of the shape would drop', async () => {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeSpatialCanvas(doc, { nodes: [], edges: [] })
      writeFacets(doc, { 'newer.writer/v9': { nested: { a: [1, 2], b: null }, extra: true } })
    })

    await withDocument(deps(store), WORKSPACE_ID, DOCUMENT_ID, async (session) => {
      expect(await facetsOf(session)).toEqual({
        'newer.writer/v9': { nested: { a: [1, 2], b: null }, extra: true },
      })
    })
  })

  it('warns once, without guessing a cause, about a canvas record that fails validation', async () => {
    const records: { level: string; data?: Record<string, unknown> }[] = []
    setLogSink((record) => records.push(record))
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeSpatialCanvas(doc, {
        nodes: [],
        edges: [],
        lines: [
          {
            id: 'ink-1',
            from: { kind: 'point', point: { x: 0, y: 0 }, end: 'none' },
            to: { kind: 'point', point: { x: 9, y: 9 }, end: 'none' },
            bends: Array.from({ length: 65 }, (_, i) => ({ x: i, y: i })),
          },
        ],
      })
    })

    await withDocument(deps(store), WORKSPACE_ID, DOCUMENT_ID, async (session) => {
      expect((await canvasOf(session)).lines ?? []).toEqual([])
    })

    const warning = records.find((record) => record.level === 'warning')
    expect(warning?.data).toMatchObject({ documentId: DOCUMENT_ID, skipped: 1 })
  })
})

describe('opening a document that was never saved', () => {
  it('refuses with SnapshotNotFoundError when it must exist', async () => {
    const handles = watchEngineHandles()

    await expect(openDocument(deps(new FakeDocumentStore()), WORKSPACE_ID, DOCUMENT_ID)).rejects.toThrow(
      SnapshotNotFoundError,
    )
    expect(handles.minted()).toEqual([])
  })

  it('answers an empty document when it may be created', async () => {
    await withDocument(
      deps(new FakeDocumentStore()),
      WORKSPACE_ID,
      DOCUMENT_ID,
      async (session) => {
        expect(await facetsOf(session)).toEqual({})
        expect(await kindOf(session)).toBeUndefined()
      },
      { create: true },
    )
  })

  it('opens an empty document through openOrCreateDocument and releases it', async () => {
    const handles = watchEngineHandles()
    const session = await openOrCreateDocument(
      deps(new FakeDocumentStore()),
      WORKSPACE_ID,
      DOCUMENT_ID,
    )
    expect(await facetsOf(session)).toEqual({})
    session.release()

    expect(handles.minted()).toHaveLength(1)
    expect(handles.unaccounted()).toEqual([])
  })
})

describe('an engine abort while a document is opened', () => {
  class TrappingStore extends InMemoryDocumentStore {
    override async loadSnapshot(_input: LoadSnapshotInput): Promise<never> {
      const err = new Error('unreachable')
      err.name = 'RuntimeError'
      throw err
    }
  }

  it.each([
    ['openDocument', openDocument],
    ['openOrCreateDocument', openOrCreateDocument],
  ])('%s answers a typed error and logs the document at error', async (_name, open) => {
    const records: { level: string; data?: Record<string, unknown> }[] = []
    setLogSink((record) => records.push(record))

    const failure = await open(
      makeTestDeps({ documentStore: new TrappingStore() }),
      WORKSPACE_ID,
      DOCUMENT_ID,
    ).catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(DocumentEngineTrapError)
    expect((failure as Error).message).toContain(`while loading document ${DOCUMENT_ID};`)
    expect(records).toContainEqual(
      expect.objectContaining({
        level: 'error',
        data: expect.objectContaining({ documentId: DOCUMENT_ID, doing: 'loading' }),
      }),
    )
  })
})

describe('the engine handles a session opens', () => {
  const seeded = async () => {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, spatial)
    return deps(store)
  }

  it('are closed once when the work returns', async () => {
    const handles = watchEngineHandles()

    await withDocument(await seeded(), WORKSPACE_ID, DOCUMENT_ID, (session) => canvasOf(session))

    expect(handles.minted()).toHaveLength(1)
    expect(handles.unaccounted()).toEqual([])
  })

  it('are closed once when the work throws, and the failure is the work\'s own', async () => {
    const handles = watchEngineHandles()

    await expect(
      withDocument(await seeded(), WORKSPACE_ID, DOCUMENT_ID, async () => {
        throw new Error('tool refused')
      }),
    ).rejects.toThrow('tool refused')

    expect(handles.minted()).toHaveLength(1)
    expect(handles.unaccounted()).toEqual([])
  })

  it('are closed once when a read is refused, and releasing again is harmless', async () => {
    const handles = watchEngineHandles()
    const session = await openDocument(await seeded(), WORKSPACE_ID, DOCUMENT_ID)

    await expect(
      session.read({ query: 'documents' }, { parse: () => { throw new Error('bad shape') } }),
    ).rejects.toThrow('bad shape')
    session.release()
    session.release()

    expect(handles.unaccounted()).toEqual([])
  })

  it('open none when the document is not found', async () => {
    const handles = watchEngineHandles()

    await expect(
      withDocument(deps(new FakeDocumentStore()), WORKSPACE_ID, DOCUMENT_ID, async () => {}),
    ).rejects.toThrow(SnapshotNotFoundError)

    expect(handles.minted()).toEqual([])
  })
})

/** The stored bytes of the one document `seedDoc` saved, read back as the adapter's own `LoroDoc`. */
async function seededDoc(store: FakeDocumentStore): Promise<LoroDoc> {
  const stored = await store.loadSnapshot({
    docRef: { kind: 'document', workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID },
  })
  if (stored === null) throw new Error('the fixture saved nothing')
  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(stored.manifest, stored.chunks))
  return doc
}
