import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { chunkSnapshot } from '@kamiazya/whiteboard-canvas-ports'
import { setNodeLock, writeSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import {
  FakeCanvasDocStore,
  registerCanvasInWorkspace,
} from '../test-utils/fake-canvas-doc-store.js'
import { createInMemoryWorkspaceIndex } from '../test-utils/in-memory-workspace-index.js'
import { loadCanvasDoc } from './canvas-doc-io.js'
import { createTidyCanvasTool } from './tidy-canvas.js'

const CANVAS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

async function seedCanvas(
  canvasDocStore: FakeCanvasDocStore,
  canvas: SpatialCanvas,
  lockedIds: readonly string[] = [],
): Promise<void> {
  await registerCanvasInWorkspace(canvasDocStore, WORKSPACE_ID, CANVAS_ID)
  const seedDoc = new LoroDoc()
  writeSpatialCanvas(seedDoc, canvas)
  for (const id of lockedIds) setNodeLock(seedDoc, id, true)
  const { manifest, chunks } = chunkSnapshot(seedDoc.export({ mode: 'snapshot' }), 1_000_000)
  await canvasDocStore.saveSnapshot({
    docRef: { kind: 'canvas', canvasId: CANVAS_ID },
    manifest,
    chunks,
    frontier: seedDoc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
  })
}

function makeDeps(canvasDocStore: FakeCanvasDocStore) {
  return { canvasDocStore, workspaceIndex: createInMemoryWorkspaceIndex(), blobStore: {} as never }
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

describe('tidy_canvas tool', () => {
  test('tidies the whole canvas and persists the moved nodes', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    // A rough row: y 101/118/95 all sit within one band of the topmost
    // (95), so everyone snaps to round8(95) = 96.
    await seedCanvas(canvasDocStore, {
      nodes: [box('a', 0, 101), box('b', 200, 118), box('c', 400, 95)],
      edges: [],
    })
    const deps = makeDeps(canvasDocStore)
    const tool = createTidyCanvasTool(deps)

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })

    expect(result.canvasId).toBe(CANVAS_ID)
    expect([...result.moved].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'a', x: 0, y: 96 },
      { id: 'b', x: 200, y: 96 },
      { id: 'c', x: 400, y: 96 },
    ])

    const { canvas } = await loadCanvasDoc(deps, CANVAS_ID)
    expect(canvas.nodes.map((n) => n.y)).toEqual([96, 96, 96])
  })

  test('a locked node never moves but still anchors its band', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seedCanvas(canvasDocStore, { nodes: [box('a', 0, 101), box('b', 200, 118)], edges: [] }, [
      'a',
    ])
    const deps = makeDeps(canvasDocStore)
    const tool = createTidyCanvasTool(deps)

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })

    // b joins a's band (118 - 101 < 24) and lands on round8(101) = 104;
    // locked a stays exactly where it was.
    expect(result.moved).toEqual([{ id: 'b', x: 200, y: 104 }])
    const { canvas } = await loadCanvasDoc(deps, CANVAS_ID)
    expect(canvas.nodes.find((n) => n.id === 'a')?.y).toBe(101)
    expect(canvas.nodes.find((n) => n.id === 'b')?.y).toBe(104)
  })

  test('scope restricts moves to the listed nodes', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seedCanvas(canvasDocStore, {
      nodes: [box('a', 0, 101), box('b', 200, 118)],
      edges: [],
    })
    const tool = createTidyCanvasTool(makeDeps(canvasDocStore))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      scope: ['a'],
    })

    expect(result.moved.every((m) => m.id === 'a')).toBe(true)
  })

  test('an already tidy canvas reports no moves and leaves the doc unchanged', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seedCanvas(canvasDocStore, {
      nodes: [box('a', 0, 0), box('b', 200, 0)],
      edges: [],
    })
    const deps = makeDeps(canvasDocStore)
    const tool = createTidyCanvasTool(deps)

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })

    expect(result.moved).toEqual([])
  })

  test('tidy output is a fixpoint: running the tool twice moves nothing more', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seedCanvas(canvasDocStore, {
      nodes: [box('a', 25, 0), box('b', 0, 0), box('c', 3, 210)],
      edges: [],
    })
    const tool = createTidyCanvasTool(makeDeps(canvasDocStore))

    await tool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })
    const second = await tool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })

    expect(second.moved).toEqual([])
  })

  test('rejects an unknown canvas', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    const tool = createTidyCanvasTool(makeDeps(canvasDocStore))

    await expect(tool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })).rejects.toThrow()
  })
})
