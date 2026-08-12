import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { chunkSnapshot } from '@kamiazya/whiteboard-canvas-ports'
import { writeSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import {
  FakeCanvasDocStore,
  registerCanvasInWorkspace,
} from '../test-utils/fake-canvas-doc-store.js'
import { createBodyPatchTool } from './body-patch.js'
import { CanvasNotFoundError } from './canvas-crud.errors.js'
import { NodeNotFoundError, NotATextNodeError, PatchValidationError } from './errors.js'

const CANVAS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

async function seedCanvas(
  canvasDocStore: FakeCanvasDocStore,
  canvas: SpatialCanvas,
): Promise<void> {
  await registerCanvasInWorkspace(canvasDocStore, WORKSPACE_ID, CANVAS_ID)
  const seedDoc = new LoroDoc()
  writeSpatialCanvas(seedDoc, canvas)
  const { manifest, chunks } = chunkSnapshot(seedDoc.export({ mode: 'snapshot' }), 1_000_000)
  await canvasDocStore.saveSnapshot({
    docRef: { kind: 'canvas', canvasId: CANVAS_ID },
    manifest,
    chunks,
    frontier: seedDoc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
  })
}

function makeDeps(canvasDocStore: FakeCanvasDocStore) {
  return { canvasDocStore, blobStore: {} as never }
}

describe('body_patch tool', () => {
  test('mode "full" replaces the entire text body', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seedCanvas(canvasDocStore, {
      nodes: [{ id: 't1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'line1\nline2' }],
      edges: [],
    })
    const tool = createBodyPatchTool(makeDeps(canvasDocStore))

    const result = await tool.execute({
      mode: 'full',
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      nodeId: 't1',
      body: 'replaced',
    })

    expect(result.node).toMatchObject({ id: 't1', type: 'text', text: 'replaced' })
  })

  test('mode "range" splices a subset of lines, preserving lines outside the range', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seedCanvas(canvasDocStore, {
      nodes: [
        {
          id: 't1',
          type: 'text',
          x: 0,
          y: 0,
          width: 100,
          height: 50,
          text: 'line0\nline1\nline2\nline3',
        },
      ],
      edges: [],
    })
    const tool = createBodyPatchTool(makeDeps(canvasDocStore))

    const result = await tool.execute({
      mode: 'range',
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      nodeId: 't1',
      range: { startLine: 1, endLine: 2, replacement: 'NEW' },
    })

    expect(result.node).toMatchObject({ id: 't1', type: 'text', text: 'line0\nNEW\nline3' })
  })

  test('throws NotATextNodeError when targeting a non-text node', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seedCanvas(canvasDocStore, {
      nodes: [{ id: 'g1', type: 'group', x: 0, y: 0, width: 100, height: 50 }],
      edges: [],
    })
    const tool = createBodyPatchTool(makeDeps(canvasDocStore))

    await expect(
      tool.execute({
        mode: 'full',
        workspaceId: WORKSPACE_ID,
        canvasId: CANVAS_ID,
        nodeId: 'g1',
        body: 'x',
      }),
    ).rejects.toThrow(NotATextNodeError)
  })

  test('throws PatchValidationError for an out-of-range line splice', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seedCanvas(canvasDocStore, {
      nodes: [
        { id: 't1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'only-one-line' },
      ],
      edges: [],
    })
    const tool = createBodyPatchTool(makeDeps(canvasDocStore))

    await expect(
      tool.execute({
        mode: 'range',
        workspaceId: WORKSPACE_ID,
        canvasId: CANVAS_ID,
        nodeId: 't1',
        range: { startLine: 0, endLine: 5, replacement: 'x' },
      }),
    ).rejects.toThrow(PatchValidationError)
  })

  test('throws NodeNotFoundError for an unknown nodeId', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seedCanvas(canvasDocStore, {
      nodes: [{ id: 't1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'x' }],
      edges: [],
    })
    const tool = createBodyPatchTool(makeDeps(canvasDocStore))

    await expect(
      tool.execute({
        mode: 'full',
        workspaceId: WORKSPACE_ID,
        canvasId: CANVAS_ID,
        nodeId: 'missing',
        body: 'x',
      }),
    ).rejects.toThrow(NodeNotFoundError)
  })

  test('throws CanvasNotFoundError when workspaceId does not actually own canvasId', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seedCanvas(canvasDocStore, {
      nodes: [{ id: 't1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'x' }],
      edges: [],
    })
    const tool = createBodyPatchTool(makeDeps(canvasDocStore))

    await expect(
      tool.execute({
        mode: 'full',
        workspaceId: 'ws-other',
        canvasId: CANVAS_ID,
        nodeId: 't1',
        body: 'x',
      }),
    ).rejects.toThrow(CanvasNotFoundError)
  })
})
