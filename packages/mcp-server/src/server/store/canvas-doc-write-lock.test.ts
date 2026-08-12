// The lost update this lock exists to prevent, demonstrated on the real
// tools rather than argued from the code: every mutating tool is a
// load-modify-save and `saveSnapshot` writes unconditionally, so two calls
// that load the same base before either saves drop one of the changes.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { chunkSnapshot, reassembleSnapshot } from '@kamiazya/whiteboard-canvas-ports'
import {
  writeSpatialCanvas as _w,
  readSpatialCanvas,
  WorkspaceTree,
} from '@kamiazya/whiteboard-canvas-workspace'
import { createNodePatchTool } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerOpenCanvasTools } from '../mcp/opencanvas-tools.js'
import { InMemoryCanvasDocStore } from './inmemory/in-memory-canvas-doc-store.js'
import { _resetWorkspaceLocksForTests, withCanvasDocWriteLock } from './workspace-lock.js'

const CANVAS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
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
function barrierOnCanvasLoads(store: InMemoryCanvasDocStore, participants: number): void {
  let arrived = 0
  let open!: () => void
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })
  const load = store.loadSnapshot.bind(store)
  store.loadSnapshot = async (input) => {
    const result = await load(input)
    if (input.docRef.kind !== 'canvas') return result
    arrived += 1
    if (arrived === participants) open()
    // Loads beyond the barrier's population must not block, or a follow-up
    // read would hang forever.
    if (arrived <= participants) await gate
    return result
  }
}

async function makeDeps() {
  const canvasDocStore = new InMemoryCanvasDocStore()

  // The patch tools assert the canvas belongs to the workspace, so the
  // workspace tree has to name it before any of them will run.
  const tree = new WorkspaceTree(new LoroDoc())
  tree.createNode(CANVAS_ID, 'doc')
  const treeChunks = chunkSnapshot(tree.exportSnapshot(), 1_000_000)
  await canvasDocStore.saveSnapshot({
    docRef: { kind: 'workspace-tree', workspaceId: WORKSPACE_ID },
    manifest: treeChunks.manifest,
    chunks: treeChunks.chunks,
    frontier: tree.exportFrontier(),
  })

  const seedDoc = new LoroDoc()
  _w(seedDoc, CANVAS)
  const { manifest, chunks } = chunkSnapshot(seedDoc.export({ mode: 'snapshot' }), 1_000_000)
  await canvasDocStore.saveSnapshot({
    docRef: { kind: 'canvas', canvasId: CANVAS_ID },
    manifest,
    chunks,
    frontier: seedDoc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
  })
  return {
    canvasDocStore,
    blobStore: {} as never,
  }
}

/** Positions of both nodes as actually stored, after everything settles. */
async function storedPositions(deps: Awaited<ReturnType<typeof makeDeps>>) {
  const stored = await deps.canvasDocStore.loadSnapshot({
    docRef: { kind: 'canvas', canvasId: CANVAS_ID },
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

describe('withCanvasDocWriteLock', () => {
  it('THE RED CASE: two unserialized patches to one canvas lose an update', async () => {
    const deps = await makeDeps()
    barrierOnCanvasLoads(deps.canvasDocStore, 2)
    const tool = createNodePatchTool(deps)

    // Both are held at the barrier until each has loaded, so they provably
    // share a base — the shape of an agent and a user editing the same
    // canvas at the same moment.
    await Promise.all([
      tool.execute({
        workspaceId: WORKSPACE_ID,
        canvasId: CANVAS_ID,
        nodeId: 'n1',
        patch: { x: 11 },
      }),
      tool.execute({
        workspaceId: WORKSPACE_ID,
        canvasId: CANVAS_ID,
        nodeId: 'n2',
        patch: { x: 22 },
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
    const tool = createNodePatchTool(deps)

    await Promise.all([
      withCanvasDocWriteLock(CANVAS_ID, () =>
        tool.execute({
          workspaceId: WORKSPACE_ID,
          canvasId: CANVAS_ID,
          nodeId: 'n1',
          patch: { x: 11 },
        }),
      ),
      withCanvasDocWriteLock(CANVAS_ID, () =>
        tool.execute({
          workspaceId: WORKSPACE_ID,
          canvasId: CANVAS_ID,
          nodeId: 'n2',
          patch: { x: 22 },
        }),
      ),
    ])

    expect(await storedPositions(deps)).toEqual({ n1: 11, n2: 22 })
  })

  it('does not serialize DIFFERENT canvases against each other', async () => {
    // A single global queue would turn every agent write into a
    // whole-server bottleneck; the key has to be the document.
    const order: string[] = []
    const slow = withCanvasDocWriteLock('canvas-a', async () => {
      await new Promise((settle) => setTimeout(settle, 50))
      order.push('a')
    })
    const quick = withCanvasDocWriteLock('canvas-b', async () => {
      order.push('b')
    })
    await Promise.all([slow, quick])
    expect(order).toEqual(['b', 'a'])
  })

  it('keeps draining after a holder throws', async () => {
    const failed = withCanvasDocWriteLock(CANVAS_ID, async () => {
      throw new Error('boom')
    })
    await expect(failed).rejects.toThrow('boom')
    // A poisoned queue would strand every later write to this canvas.
    await expect(withCanvasDocWriteLock(CANVAS_ID, async () => 'ok')).resolves.toBe('ok')
  })
})

// Wiring, verified by RUNNING the registered handlers rather than by
// reading the source: a string check would pass on a wrapping that had
// been syntactically kept but semantically bypassed, and would break on
// reformatting.
describe('registered MCP handlers', () => {
  function registeredHandlers(deps: Awaited<ReturnType<typeof makeDeps>>) {
    const registerTool = vi.fn()
    registerOpenCanvasTools({ registerTool } as never, deps as never)
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
    const load = deps.canvasDocStore.loadSnapshot.bind(deps.canvasDocStore)
    const save = deps.canvasDocStore.saveSnapshot.bind(deps.canvasDocStore)
    deps.canvasDocStore.loadSnapshot = async (input) => {
      if (input.docRef.kind === 'canvas') events.push('load')
      return load(input)
    }
    deps.canvasDocStore.saveSnapshot = async (input) => {
      if (input.docRef.kind === 'canvas') events.push('save')
      return save(input)
    }

    const handlers = registeredHandlers(deps)
    const nodePatch = handlers.get('wb_wb_node_patch')!
    await Promise.all([
      nodePatch(
        { workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, nodeId: 'n1', patch: { x: 11 } },
        {},
      ),
      nodePatch(
        { workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, nodeId: 'n2', patch: { x: 22 } },
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
    const save = deps.canvasDocStore.saveSnapshot.bind(deps.canvasDocStore)
    deps.canvasDocStore.saveSnapshot = async (input) => {
      if (input.docRef.kind === 'canvas') await writeHeld
      return save(input)
    }

    const writing = handlers.get('wb_wb_node_patch')!(
      { workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, nodeId: 'n1', patch: { x: 11 } },
      {},
    )
    const read = await handlers.get('wb_scene_digest')!(
      { workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID },
      {},
    )
    expect(read).toBeDefined()

    releaseWrite()
    await writing
  })
})
