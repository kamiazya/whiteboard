// The lost update this lock exists to prevent, demonstrated on the real
// tools rather than argued from the code: every mutating tool is a
// load-modify-save and `saveSnapshot` writes unconditionally, so two calls
// that load the same base before either saves drop one of the changes.
import { writeSpatialCanvas as _w, readSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { chunkSnapshot, reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { createCanvasEditTool } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerDocumentTools } from '../mcp/document-tools.js'
import { InMemoryDocumentStore } from './inmemory/in-memory-document-store.js'
import { _resetWorkspaceLocksForTests, withDocumentWriteLock } from './workspace-lock.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

const CANVAS: SpatialCanvas = {
  nodes: [
    { id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'a' },
    { id: 'n2', type: 'text', x: 200, y: 0, width: 100, height: 50, text: 'b' },
  ],
  edges: [],
}

/**
 * Holds the first `participants` canvas loads until all of them have
 * arrived, so "both calls loaded the same base" is constructed rather than
 * left to the scheduler. Without this the race the test means to create
 * might simply not happen, and the test would pass for the wrong reason.
 */
function barrierOnCanvasLoads(store: InMemoryDocumentStore, participants: number): void {
  let arrived = 0
  let open!: () => void
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })
  const load = store.loadSnapshot.bind(store)
  store.loadSnapshot = async (input) => {
    const result = await load(input)
    if (input.docRef.kind !== 'document') return result
    arrived += 1
    if (arrived === participants) open()
    // Loads beyond the barrier's population must not block, or a follow-up
    // read would hang forever.
    if (arrived <= participants) await gate
    return result
  }
}

async function makeDeps() {
  const documentStore = new InMemoryDocumentStore()

  // The patch tools assert the canvas belongs to the workspace, so the
  // index has to name it before any of them will run.
  const documentIndex = new InMemoryDocumentIndex()
  documentIndex.seed({
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    path: 'doc',
    kind: 'spatial',
  })

  const seedDoc = new LoroDoc()
  _w(seedDoc, CANVAS)
  const { manifest, chunks } = chunkSnapshot(seedDoc.export({ mode: 'snapshot' }), 1_000_000)
  await documentStore.saveSnapshot({
    docRef: { kind: 'document', documentId: DOCUMENT_ID },
    manifest,
    chunks,
    frontier: seedDoc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
  })
  return {
    documentStore,
    blobStore: {} as never,
    documentIndex,
  }
}

/** Positions of both nodes as actually stored, after everything settles. */
async function storedPositions(deps: Awaited<ReturnType<typeof makeDeps>>) {
  const stored = await deps.documentStore.loadSnapshot({
    docRef: { kind: 'document', documentId: DOCUMENT_ID },
  })
  if (stored === null) throw new Error('no snapshot')
  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(stored.manifest, stored.chunks))
  const canvas = readSpatialCanvas(doc)
  return Object.fromEntries(canvas.nodes.map((node) => [node.id, node.x]))
}

beforeEach(() => {
  _resetWorkspaceLocksForTests()
})

describe('withDocumentWriteLock', () => {
  it('THE RED CASE: two unserialized patches to one canvas lose an update', async () => {
    const deps = await makeDeps()
    barrierOnCanvasLoads(deps.documentStore, 2)
    const tool = createCanvasEditTool(deps)

    // Both are held at the barrier until each has loaded, so they provably
    // share a base — the shape of an agent and a user editing the same
    // canvas at the same moment.
    await Promise.all([
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        ops: [{ op: 'node.patch', id: 'n1', patch: { x: 11 } }],
      }),
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        ops: [{ op: 'node.patch', id: 'n2', patch: { x: 22 } }],
      }),
    ])

    const positions = await storedPositions(deps)
    // Exactly one of the two survives: this test documents the hazard, so
    // if a future change makes the unserialized path safe by itself, this
    // failing is the signal the lock can go.
    const survived = [positions.n1 === 11, positions.n2 === 22].filter(Boolean).length
    expect(survived).toBe(1)
  })

  it('serializes them so both survive', async () => {
    const deps = await makeDeps()
    const tool = createCanvasEditTool(deps)

    await Promise.all([
      withDocumentWriteLock(DOCUMENT_ID, () =>
        tool.execute({
          workspaceId: WORKSPACE_ID,
          documentId: DOCUMENT_ID,
          ops: [{ op: 'node.patch', id: 'n1', patch: { x: 11 } }],
        }),
      ),
      withDocumentWriteLock(DOCUMENT_ID, () =>
        tool.execute({
          workspaceId: WORKSPACE_ID,
          documentId: DOCUMENT_ID,
          ops: [{ op: 'node.patch', id: 'n2', patch: { x: 22 } }],
        }),
      ),
    ])

    expect(await storedPositions(deps)).toEqual({ n1: 11, n2: 22 })
  })

  it('does not serialize DIFFERENT documents against each other', async () => {
    // A single global queue would turn every agent write into a
    // whole-server bottleneck; the key has to be the document.
    const order: string[] = []
    const slow = withDocumentWriteLock('canvas-a', async () => {
      await new Promise((settle) => setTimeout(settle, 50))
      order.push('a')
    })
    const quick = withDocumentWriteLock('canvas-b', async () => {
      order.push('b')
    })
    await Promise.all([slow, quick])
    expect(order).toEqual(['b', 'a'])
  })

  it('keeps draining after a holder throws', async () => {
    const failed = withDocumentWriteLock(DOCUMENT_ID, async () => {
      throw new Error('boom')
    })
    await expect(failed).rejects.toThrow('boom')
    // A poisoned queue would strand every later write to this canvas.
    await expect(withDocumentWriteLock(DOCUMENT_ID, async () => 'ok')).resolves.toBe('ok')
  })
})

// Wiring, verified by RUNNING the registered handlers rather than by
// reading the source: a string check would pass on a wrapping that had
// been syntactically kept but semantically bypassed, and would break on
// reformatting.
describe('registered MCP handlers', () => {
  function registeredHandlers(deps: Awaited<ReturnType<typeof makeDeps>>) {
    const registerTool = vi.fn()
    registerDocumentTools({ registerTool } as never, deps as never)
    const byName = new Map<string, (args: unknown, extra: unknown) => Promise<unknown>>()
    for (const call of registerTool.mock.calls) {
      byName.set(call[0] as string, call[2] as never)
    }
    return byName
  }

  it('serializes two mutating handlers on the same canvas', async () => {
    const deps = await makeDeps()
    // A barrier cannot be used here: once the calls ARE serialized the
    // second one never loads until the first finishes, so waiting for both
    // to arrive deadlocks. Record the store traffic instead and assert the
    // shape directly — interleaved load/load/save/save is the lost update,
    // load/save/load/save is the fix.
    const events: string[] = []
    const load = deps.documentStore.loadSnapshot.bind(deps.documentStore)
    const save = deps.documentStore.saveSnapshot.bind(deps.documentStore)
    deps.documentStore.loadSnapshot = async (input) => {
      if (input.docRef.kind === 'document') events.push('load')
      return load(input)
    }
    deps.documentStore.saveSnapshot = async (input) => {
      if (input.docRef.kind === 'document') events.push('save')
      return save(input)
    }

    const handlers = registeredHandlers(deps)
    const canvasEdit = handlers.get('wb_canvas_edit')!
    await Promise.all([
      canvasEdit(
        {
          workspaceId: WORKSPACE_ID,
          documentId: DOCUMENT_ID,
          ops: [{ op: 'node.patch', id: 'n1', patch: { x: 11 } }],
        },
        {},
      ),
      canvasEdit(
        {
          workspaceId: WORKSPACE_ID,
          documentId: DOCUMENT_ID,
          ops: [{ op: 'node.patch', id: 'n2', patch: { x: 22 } }],
        },
        {},
      ),
    ])

    // The exact event count is an implementation detail; the property is
    // that the second call never reads a base the first had not yet written.
    const firstSave = events.indexOf('save')
    const secondLoad = events.indexOf('load', events.indexOf('load') + 1)
    expect(firstSave, `store traffic was ${events.join(',')}`).toBeGreaterThan(-1)
    expect(secondLoad, `store traffic was ${events.join(',')}`).toBeGreaterThan(firstSave)
    expect(await storedPositions(deps)).toEqual({ n1: 11, n2: 22 })
  })

  it('does not queue a READ-ONLY handler behind a held write', async () => {
    const deps = await makeDeps()
    const handlers = registeredHandlers(deps)

    // Hold the write inside its critical section, then check a read still
    // completes. Serializing reads behind writes would make a render wait
    // on an unrelated patch for no correctness gain.
    let releaseWrite!: () => void
    const writeHeld = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    const save = deps.documentStore.saveSnapshot.bind(deps.documentStore)
    deps.documentStore.saveSnapshot = async (input) => {
      if (input.docRef.kind === 'document') await writeHeld
      return save(input)
    }

    const writing = handlers.get('wb_canvas_edit')!(
      {
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        ops: [{ op: 'node.patch', id: 'n1', patch: { x: 11 } }],
      },
      {},
    )
    const read = await handlers.get('wb_canvas_snapshot')!(
      { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID },
      {},
    )
    expect(read).toBeDefined()

    releaseWrite()
    await writing
  })
})
