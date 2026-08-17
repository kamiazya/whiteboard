import {
  setNodeLock,
  writeDocumentKind,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { chunkSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { loadDocument } from './document-io.js'
import { DocumentKindMismatchError } from './errors.js'
import { createTidyCanvasTool } from './tidy-canvas.js'

const CANVAS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

async function seedCanvas(
  documentStore: FakeDocumentStore,
  canvas: SpatialCanvas,
  lockedIds: readonly string[] = [],
): Promise<void> {
  await registerDocumentInWorkspace(documentStore, WORKSPACE_ID, CANVAS_ID)
  const seedDoc = new LoroDoc()
  writeSpatialCanvas(seedDoc, canvas)
  for (const id of lockedIds) setNodeLock(seedDoc, id, true)
  const { manifest, chunks } = chunkSnapshot(seedDoc.export({ mode: 'snapshot' }), 1_000_000)
  await documentStore.saveSnapshot({
    docRef: { kind: 'document', documentId: CANVAS_ID },
    manifest,
    chunks,
    frontier: seedDoc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
  })
}

function makeDeps(documentStore: FakeDocumentStore) {
  return { documentStore, blobStore: {} as never, documentIndex: documentStore.documentIndex }
}

const box = (id: string, x: number, y: number) => ({
  id,
  type: 'text' as const,
  x,
  y,
  width: 100,
  height: 50,
  text: id,
})

describe('wb_canvas_tidy tool', () => {
  test('tidies the whole canvas and persists the moved nodes', async () => {
    const documentStore = new FakeDocumentStore()
    // A rough row: y 101/118/95 all sit within one band of the topmost
    // (95), so everyone snaps to round8(95) = 96.
    await seedCanvas(documentStore, {
      nodes: [box('a', 0, 101), box('b', 200, 118), box('c', 400, 95)],
      edges: [],
    })
    const deps = makeDeps(documentStore)
    const tool = createTidyCanvasTool(deps)

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, documentId: CANVAS_ID })

    expect(result.documentId).toBe(CANVAS_ID)
    expect([...result.moved].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'a', x: 0, y: 96 },
      { id: 'b', x: 200, y: 96 },
      { id: 'c', x: 400, y: 96 },
    ])

    const { canvas } = await loadDocument(deps, CANVAS_ID)
    expect(canvas.nodes.map((n) => n.y)).toEqual([96, 96, 96])
  })

  test('a locked node never moves but still anchors its band', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore, { nodes: [box('a', 0, 101), box('b', 200, 118)], edges: [] }, [
      'a',
    ])
    const deps = makeDeps(documentStore)
    const tool = createTidyCanvasTool(deps)

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, documentId: CANVAS_ID })

    // b joins a's band (118 - 101 < 24) and lands on round8(101) = 104;
    // locked a stays exactly where it was.
    expect(result.moved).toEqual([{ id: 'b', x: 200, y: 104 }])
    const { canvas } = await loadDocument(deps, CANVAS_ID)
    expect(canvas.nodes.find((n) => n.id === 'a')?.y).toBe(101)
    expect(canvas.nodes.find((n) => n.id === 'b')?.y).toBe(104)
  })

  test('scope restricts moves to the listed nodes', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore, {
      nodes: [box('a', 0, 101), box('b', 200, 118)],
      edges: [],
    })
    const tool = createTidyCanvasTool(makeDeps(documentStore))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: CANVAS_ID,
      scope: ['a'],
    })

    expect(result.moved.every((m) => m.id === 'a')).toBe(true)
  })

  test('an already tidy canvas reports no moves and leaves the doc unchanged', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore, {
      nodes: [box('a', 0, 0), box('b', 200, 0)],
      edges: [],
    })
    const deps = makeDeps(documentStore)
    const tool = createTidyCanvasTool(deps)

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, documentId: CANVAS_ID })

    expect(result.moved).toEqual([])
  })

  test('tidy output is a fixpoint: running the tool twice moves nothing more', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore, {
      nodes: [box('a', 25, 0), box('b', 0, 0), box('c', 3, 210)],
      edges: [],
    })
    const tool = createTidyCanvasTool(makeDeps(documentStore))

    await tool.execute({ workspaceId: WORKSPACE_ID, documentId: CANVAS_ID })
    const second = await tool.execute({ workspaceId: WORKSPACE_ID, documentId: CANVAS_ID })

    expect(second.moved).toEqual([])
  })

  test('rejects an unknown canvas', async () => {
    const documentStore = new FakeDocumentStore()
    const tool = createTidyCanvasTool(makeDeps(documentStore))

    await expect(
      tool.execute({ workspaceId: WORKSPACE_ID, documentId: CANVAS_ID }),
    ).rejects.toThrow()
  })
})

describe('wb_canvas_tidy on a markdown document', () => {
  test('refuses it, rather than repositioning the node holding its OKF body', async () => {
    // The description has always said "spatial documents only", and the
    // spatial-schema parse it credited for that never enforced it: a
    // markdown document's stored content IS a valid spatial canvas, so it
    // parsed and tidy went ahead.
    //
    // Two nodes, because that is the case where it is not merely untidy but
    // wrong: tidy returns no moves for a lone node, so a document written by
    // wb_document_set (exactly one body node) was a silent no-op. A markdown
    // document predating the format guards, or one the web editor gave a
    // second node, is the one that got repositioned.
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    await seedDoc(store, CANVAS_ID, (doc) => {
      writeDocumentKind(doc, 'markdown')
      writeSpatialCanvas(doc, {
        nodes: [
          { id: 'okf-body', type: 'text', x: 3, y: 7, width: 200, height: 100, text: 'body' },
          { id: 'stray', type: 'text', x: 211, y: 9, width: 200, height: 100, text: 'stray' },
        ],
        edges: [],
      })
    })
    const deps = makeDeps(store)

    await expect(
      createTidyCanvasTool(deps).execute({ workspaceId: WORKSPACE_ID, documentId: CANVAS_ID }),
    ).rejects.toThrow(DocumentKindMismatchError)

    const { canvas } = await loadDocument(deps, CANVAS_ID)
    expect(canvas.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y }))).toEqual([
      { id: 'okf-body', x: 3, y: 7 },
      { id: 'stray', x: 211, y: 9 },
    ])
  })
})
