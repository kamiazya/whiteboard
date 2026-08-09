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
import { beforeEach, describe, expect, it } from 'vitest'
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
    workspaceIndex: {
      // Only the reindex hook touches this, and it is a no-op for this test.
      applyRows: async () => {},
      listCanvases: async () => ({ canvases: [] }),
      resolveAlias: async () => null,
      listBacklinks: async () => ({ backlinks: [] }),
      listFacetIndex: async () => ({ rows: [] }),
      listAliasHistory: async () => ({ rows: [] }),
    } as never,
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
    const tool = createNodePatchTool(deps)

    // Both start before either saves — the shape of an agent and a user
    // editing the same canvas at the same moment.
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

// A tier-2 conformance guard: the lock only helps where it is actually
// applied, and a new mutating tool added without it would reintroduce the
// exact loss the tests above demonstrate. Read-only tools must stay
// unwrapped so a render never queues behind an unrelated patch.
describe('opencanvas-tools wiring', () => {
  const MUTATING = [
    'facetSet',
    'nodePatch',
    'nodeLock',
    'edgeLock',
    'edgePatch',
    'versionSave',
    'versionRestore',
    'canvasImportOkf',
  ]
  const READ_ONLY = [
    'canvasRenderSvg',
    'canvasDigest',
    'canvasExportOkf',
    'canvasExportJsonCanvas',
    'versionList',
  ]

  it('wraps every mutating tool, and no read-only one', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../mcp/opencanvas-tools.ts', import.meta.url), 'utf8')
    for (const name of MUTATING) {
      expect(
        source.includes(
          `withCanvasDocWriteLock(parsed.canvasId, () =>\n        tools.${name}.execute(parsed),`,
        ),
        `${name} must run inside withCanvasDocWriteLock`,
      ).toBe(true)
    }
    for (const name of READ_ONLY) {
      expect(
        source.includes(`const result = await tools.${name}.execute(parsed)`),
        `${name} is read-only and must NOT be serialized behind writes`,
      ).toBe(true)
    }
  })
})
