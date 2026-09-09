import {
  constantRatioMeasureText,
  createSpatialTheme,
  naturalNodeContentSize,
  SPATIAL_THEME_GEOMETRY,
} from '@kamiazya/whiteboard-canvas-render'
import {
  readDocumentKind,
  readEdgeLocks,
  readNodeLocks,
  writeDocumentKind,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect, test } from 'vitest'
import type { AgentActivity, ServerDeps, ViewportRequest } from '../server-deps.js'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import {
  canvasEditInputSchema,
  createCanvasEditTool,
  PLACEMENT_COLUMNS,
  PLACEMENT_GUTTER_PX,
} from './canvas-edit.js'
import { loadDocument } from './document-io.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

function makeDeps(documentStore: FakeDocumentStore): ServerDeps {
  return makeTestDeps({
    documentStore: documentStore,
    documentIndex: documentStore.documentIndex,
  })
}

async function seedCanvas(store: FakeDocumentStore, canvas: SpatialCanvas): Promise<void> {
  await seedDoc(store, DOCUMENT_ID, (doc) => {
    writeDocumentKind(doc, 'spatial')
    writeSpatialCanvas(doc, canvas)
  })
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
}

const EMPTY: SpatialCanvas = { nodes: [], edges: [] }

describe('wb_canvas_edit tool', () => {
  test('builds a whole diagram in one call and answers with the resulting board', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, EMPTY)
    const tool = createCanvasEditTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        {
          op: 'node.add',
          node: { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 40, text: 'A' },
        },
        {
          op: 'node.add',
          node: { id: 'b', type: 'text', x: 200, y: 0, width: 100, height: 40, text: 'B' },
        },
        { op: 'edge.add', edge: { id: 'e', fromNode: 'a', toNode: 'b', label: 'to' } },
      ],
    })

    expect(result.applied).toBe(3)
    expect(result.touched).toEqual({ nodes: ['a', 'b'], edges: ['e'], comments: [] })
    // The result carries the board AFTER the batch, so a caller never has
    // to spend a second round trip re-reading what it just wrote.
    expect(result.snapshot.nodes.map((n) => n.id)).toEqual(['a', 'b'])
    expect(result.snapshot.edges.map((e) => e.id)).toEqual(['e'])
    expect(result.snapshot.nodeCount).toBe(2)
  })

  test('is all-or-nothing: a failing op leaves the stored canvas untouched', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'A' }],
      edges: [],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [
          {
            op: 'node.add',
            node: { id: 'b', type: 'text', x: 50, y: 0, width: 10, height: 10, text: 'B' },
          },
          // 'ghost' is not on the canvas — this op cannot apply.
          { op: 'node.patch', id: 'ghost', patch: { x: 5 } },
        ],
      }),
    ).rejects.toMatchObject({
      name: 'CanvasEditError',
      opIndex: 1,
      // The index has to be in the message: a model fixing a rejected batch
      // needs to know WHICH op it got wrong, and only the message survives
      // the MCP error path.
      message: expect.stringMatching(/ops\[1\]/),
    })

    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.nodes.map((n) => n.id)).toEqual(['a'])
  })

  test('places a node that carries no geometry, and reports where it landed', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [{ id: 'anchor', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'anchor' }],
      edges: [],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'node.add', node: { id: 'free', type: 'text', text: 'no coordinates' } }],
    })

    const placed = result.geometry.find((entry) => entry.id === 'free')
    expect(placed).toBeDefined()
    // Below the existing content, never on top of it — an agent asked for a
    // node, not for the anchor to be covered up.
    expect(placed?.y).toBeGreaterThanOrEqual(50 + PLACEMENT_GUTTER_PX)
    expect(placed?.width).toBeGreaterThan(0)
    expect(placed?.height).toBeGreaterThan(0)

    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    const stored = canvas.nodes.find((n) => n.id === 'free')
    // What the tool REPORTS and what it STORED have to be the same numbers.
    expect(stored).toMatchObject({ x: placed?.x, y: placed?.y })
  })

  test('lays placed nodes out in rows rather than stacking them all in one spot', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, EMPTY)
    const tool = createCanvasEditTool(makeDeps(store))

    const count = PLACEMENT_COLUMNS + 1
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: Array.from({ length: count }, (_, i) => ({
        op: 'node.add' as const,
        node: { id: `n${i}`, type: 'text' as const, text: `n${i}` },
      })),
    })

    const byId = new Map(result.geometry.map((entry) => [entry.id, entry]))
    const first = byId.get('n0')
    const second = byId.get('n1')
    const wrapped = byId.get(`n${PLACEMENT_COLUMNS}`)
    expect(second?.x).toBeGreaterThan(first?.x ?? 0)
    expect(second?.y).toBe(first?.y)
    // The (PLACEMENT_COLUMNS + 1)-th starts a new row back at the left.
    expect(wrapped?.y).toBeGreaterThan(first?.y ?? 0)
    expect(wrapped?.x).toBe(first?.x)

    // No two placed nodes share a position — the regression this guards is
    // a placement cursor that never advances.
    const positions = result.geometry.map((entry) => `${entry.x},${entry.y}`)
    expect(new Set(positions).size).toBe(count)
  })

  test('patches, removes, and reports every element it touched', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [
        { id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'A' },
        { id: 'b', type: 'text', x: 50, y: 0, width: 10, height: 10, text: 'B' },
      ],
      edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        { op: 'node.patch', id: 'a', patch: { x: 7, color: '3' } },
        { op: 'edge.remove', id: 'e' },
        { op: 'node.remove', id: 'b' },
      ],
    })

    expect(result.touched).toEqual({ nodes: ['a', 'b'], edges: ['e'], comments: [] })
    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.nodes.map((n) => n.id)).toEqual(['a'])
    expect(canvas.nodes[0]).toMatchObject({ x: 7, color: '3' })
    expect(canvas.edges).toEqual([])
  })

  test('removing a node also removes the edges that were attached to it', async () => {
    // Leaving a dangling edge behind would store a canvas that
    // spatialCanvasSchema rejects on the next read — the batch has to keep
    // the board valid, not just apply the op it was handed.
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [
        { id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'A' },
        { id: 'b', type: 'text', x: 50, y: 0, width: 10, height: 10, text: 'B' },
      ],
      edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'node.remove', id: 'b' }],
    })

    expect(result.touched.edges).toEqual(['e'])
    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.edges).toEqual([])
  })

  test('honours a lock set before the batch, and one set inside it', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [
        { id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'A' },
        { id: 'b', type: 'text', x: 50, y: 0, width: 10, height: 10, text: 'B' },
      ],
      edges: [],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'node.lock', id: 'a', locked: true }],
    })

    // A lock the batch itself set binds the ops after it, exactly as a lock
    // set in an earlier call does.
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [
          { op: 'node.lock', id: 'b', locked: true },
          { op: 'node.patch', id: 'b', patch: { x: 1 } },
        ],
      }),
    ).rejects.toMatchObject({ name: 'CanvasEditError', opIndex: 1 })

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [{ op: 'node.patch', id: 'a', patch: { x: 1 } }],
      }),
    ).rejects.toMatchObject({ name: 'CanvasEditError', opIndex: 0 })

    // The rejected batch above must not have persisted its own lock on 'b'.
    const { doc } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(readNodeLocks(doc).has('a')).toBe(true)
    expect(readNodeLocks(doc).has('b')).toBe(false)
  })

  test('unlocking is the one op a locked element still accepts', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'A' }],
      edges: [],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'node.lock', id: 'a', locked: true }],
    })
    // An agent has to be able to lift its own mistake without a human at
    // the keyboard (the rule the retired wb_node_lock established).
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        { op: 'node.lock', id: 'a', locked: false },
        { op: 'node.patch', id: 'a', patch: { x: 9 } },
      ],
    })

    expect(result.applied).toBe(2)
    const { doc, canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(readNodeLocks(doc).has('a')).toBe(false)
    expect(canvas.nodes[0]).toMatchObject({ x: 9 })
  })

  test('locks an edge, and refuses a patch on it', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [
        { id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'A' },
        { id: 'b', type: 'text', x: 50, y: 0, width: 10, height: 10, text: 'B' },
      ],
      edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'edge.lock', id: 'e', locked: true }],
    })
    const { doc } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(readEdgeLocks(doc).has('e')).toBe(true)

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [{ op: 'edge.patch', id: 'e', patch: { label: 'nope' } }],
      }),
    ).rejects.toMatchObject({ name: 'CanvasEditError', opIndex: 0 })
  })

  test('tidy runs as an op and reports what it moved through geometry', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, EMPTY)
    const tool = createCanvasEditTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        {
          op: 'node.add',
          node: { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 100, text: 'A' },
        },
        {
          op: 'node.add',
          // Deliberately overlapping 'a' so tidy has something to separate.
          node: { id: 'b', type: 'text', x: 10, y: 10, width: 100, height: 100, text: 'B' },
        },
        { op: 'tidy' },
      ],
    })

    expect(result.geometry.length).toBeGreaterThan(0)
    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    // Every geometry entry names where the node really ended up.
    for (const entry of result.geometry) {
      expect(canvas.nodes.find((n) => n.id === entry.id)).toMatchObject({
        x: entry.x,
        y: entry.y,
      })
    }
  })

  test('refuses to write into a markdown document', async () => {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeDocumentKind(doc, 'markdown')
      writeMarkdownBody(doc, '# prose')
    })
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    const tool = createCanvasEditTool(makeDeps(store))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [{ op: 'node.add', node: { id: 'a', type: 'text', text: 'A' } }],
      }),
    ).rejects.toMatchObject({ name: 'DocumentKindMismatchError' })
  })

  test('refuses an id that is already taken rather than overwriting it', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'original' }],
      edges: [],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [{ op: 'node.add', node: { id: 'a', type: 'text', text: 'replacement' } }],
      }),
    ).rejects.toMatchObject({ name: 'CanvasEditError', opIndex: 0 })
  })

  test('mints an id for a node that does not name one, and reports it', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, EMPTY)
    const tool = createCanvasEditTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'node.add', node: { type: 'text', text: 'anonymous' } }],
    })

    expect(result.touched.nodes).toHaveLength(1)
    const minted = result.touched.nodes[0]
    expect(minted).toMatch(/\S/)
    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.nodes.map((n) => n.id)).toEqual([minted])
  })

  test('refuses an edge whose endpoint the batch never creates', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, EMPTY)
    const tool = createCanvasEditTool(makeDeps(store))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [
          { op: 'node.add', node: { id: 'a', type: 'text', text: 'A' } },
          { op: 'edge.add', edge: { id: 'e', fromNode: 'a', toNode: 'missing' } },
        ],
      }),
    ).rejects.toMatchObject({ name: 'CanvasEditError', opIndex: 1 })
  })

  test('accepts an edge to a node the SAME batch created earlier', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, EMPTY)
    const tool = createCanvasEditTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        { op: 'node.add', node: { id: 'a', type: 'text', text: 'A' } },
        { op: 'node.add', node: { id: 'b', type: 'text', text: 'B' } },
        { op: 'edge.add', edge: { id: 'e', fromNode: 'a', toNode: 'b' } },
      ],
    })

    expect(result.applied).toBe(3)
    expect(result.snapshot.edges).toHaveLength(1)
  })
})

/**
 * Behaviour inherited from the seven single-purpose tools this batch tool
 * replaced (`wb_node_add` / `wb_node_patch` / `wb_edge_add` /
 * `wb_edge_patch` / `wb_node_lock` / `wb_edge_lock` / `wb_canvas_tidy`).
 *
 * Ported BEFORE those tools were deleted, so the retirement is backed by
 * green tests rather than by an argument. The precedent this guards against
 * is the `annotate` tool, removed with nothing replacing it — every caller
 * kept looking live and failed at the host with an unknown-tool error.
 */
describe('wb_canvas_edit — behaviour inherited from the retired tools', () => {
  test('records a document that predates kinds as spatial (from wb_node_add)', async () => {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeSpatialCanvas(doc, EMPTY)
    })
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    const tool = createCanvasEditTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'node.add', node: { id: 'a', type: 'text', text: 'A' } }],
    })

    const { doc } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(readDocumentKind(doc)).toBe('spatial')
  })

  test('rejects a canvas the workspace does not own (from every mutation tool)', async () => {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeSpatialCanvas(doc, EMPTY)
    })
    // Deliberately NOT registered under WORKSPACE_ID.
    const tool = createCanvasEditTool(makeDeps(store))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [{ op: 'node.add', node: { id: 'a', type: 'text', text: 'A' } }],
      }),
    ).rejects.toMatchObject({ name: 'WorkspaceDocumentNotFoundError' })
  })

  test('rejects a canvas with no saved snapshot (from wb_node_patch)', async () => {
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    const tool = createCanvasEditTool(makeDeps(store))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [{ op: 'node.patch', id: 'a', patch: { x: 1 } }],
      }),
    ).rejects.toMatchObject({ name: 'SnapshotNotFoundError' })
  })

  test('rejects a negative width at the schema level (from wb_node_patch)', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'A' }],
      edges: [],
    })

    const parsed = canvasEditInputSchema.safeParse({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'node.patch', id: 'a', patch: { width: -1 } }],
    })
    expect(parsed.success).toBe(false)

    // A non-negative width still parses, so the rejection above is the
    // sign constraint and not the op shape.
    expect(
      canvasEditInputSchema.safeParse({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [{ op: 'node.patch', id: 'a', patch: { width: 1 } }],
      }).success,
    ).toBe(true)
  })

  test('rejects an invalid arrowhead end at the schema level (from wb_edge_patch)', async () => {
    const parsed = canvasEditInputSchema.safeParse({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'edge.patch', id: 'e', patch: { toEnd: 'triangle' } }],
    })
    expect(parsed.success).toBe(false)

    const valid = canvasEditInputSchema.safeParse({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'edge.patch', id: 'e', patch: { toEnd: 'arrow', fromEnd: 'none' } }],
    })
    expect(valid.success).toBe(true)
  })

  test('a locked NODE does not freeze the edges touching it (from wb_edge_patch)', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [
        { id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'A' },
        { id: 'b', type: 'text', x: 50, y: 0, width: 10, height: 10, text: 'B' },
      ],
      edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        { op: 'node.lock', id: 'a', locked: true },
        // Only an edge's OWN lock stops it being patched.
        { op: 'edge.patch', id: 'e', patch: { label: 'still editable' } },
      ],
    })

    expect(result.applied).toBe(2)
    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.edges[0]).toMatchObject({ label: 'still editable' })
  })

  test('an edge lock does not lock a node sharing the same id (from wb_edge_lock)', async () => {
    // Nodes and edges have separate lock sets, and model has no distinct
    // edge-id shape — so a same-spelled id must not leak across them.
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [
        { id: 'x', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'node x' },
        { id: 'y', type: 'text', x: 50, y: 0, width: 10, height: 10, text: 'node y' },
      ],
      edges: [{ id: 'x', fromNode: 'x', toNode: 'y' }],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        { op: 'edge.lock', id: 'x', locked: true },
        { op: 'node.patch', id: 'x', patch: { x: 5 } },
      ],
    })

    expect(result.applied).toBe(2)
    const { doc, canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(readEdgeLocks(doc).has('x')).toBe(true)
    expect(readNodeLocks(doc).has('x')).toBe(false)
    expect(canvas.nodes.find((n) => n.id === 'x')).toMatchObject({ x: 5 })
  })

  test('tidy never moves a locked node (from wb_canvas_tidy)', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [
        { id: 'pinned', type: 'text', x: 0, y: 0, width: 100, height: 100, text: 'pinned' },
        { id: 'loose', type: 'text', x: 10, y: 10, width: 100, height: 100, text: 'loose' },
      ],
      edges: [],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'node.lock', id: 'pinned', locked: true }, { op: 'tidy' }],
    })

    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.nodes.find((n) => n.id === 'pinned')).toMatchObject({ x: 0, y: 0 })
  })

  test('tidy scope restricts moves to the listed nodes (from wb_canvas_tidy)', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [
        { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 100, text: 'A' },
        { id: 'b', type: 'text', x: 10, y: 10, width: 100, height: 100, text: 'B' },
        { id: 'c', type: 'text', x: 900, y: 900, width: 100, height: 100, text: 'C' },
      ],
      edges: [],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'tidy', scope: ['b'] }],
    })

    expect(result.geometry.every((entry) => entry.id === 'b')).toBe(true)
    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.nodes.find((n) => n.id === 'c')).toMatchObject({ x: 900, y: 900 })
  })

  test('tidy is a fixpoint: a second run moves nothing (from wb_canvas_tidy)', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [
        { id: 'a', type: 'text', x: 3, y: 7, width: 100, height: 100, text: 'A' },
        { id: 'b', type: 'text', x: 11, y: 13, width: 100, height: 100, text: 'B' },
      ],
      edges: [],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'tidy' }],
    })
    const second = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'tidy' }],
    })

    expect(second.geometry).toEqual([])
    expect(second.touched).toEqual({ nodes: [], edges: [], comments: [] })
  })
})

/**
 * Telling a human what an agent just did. Everything here is best effort:
 * a daemon with no browser attached is the normal case, so a batch must
 * apply identically whether or not anyone is listening.
 */
describe('wb_canvas_edit — telling the browser what happened', () => {
  function makeNotifier() {
    const activities: AgentActivity[] = []
    const viewports: ViewportRequest[] = []
    return {
      activities,
      viewports,
      notifier: {
        agentActivity: (activity: AgentActivity) => {
          activities.push(activity)
        },
        versionCreated: () => {},
        restoreProgress: () => {},
        requestViewport: async (request: ViewportRequest) => {
          viewports.push(request)
          return true
        },
      },
    }
  }

  test('reports what it touched, and moves the viewport onto it', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, EMPTY)
    const { activities, viewports, notifier } = makeNotifier()
    const tool = createCanvasEditTool({ ...makeDeps(store), clientNotifier: notifier })

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        { op: 'node.add', node: { id: 'a', type: 'text', text: 'A' } },
        { op: 'node.add', node: { id: 'b', type: 'text', text: 'B' } },
      ],
    })

    expect(activities).toHaveLength(1)
    expect(activities[0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      touched: { nodes: ['a', 'b'], edges: [] },
    })
    // The summary is what a human reads in a toast, so it has to say
    // something — an empty string would render as a blank notification.
    expect(activities[0].summary).toMatch(/\S/)

    expect(viewports).toHaveLength(1)
    expect(viewports[0]).toMatchObject({
      documentId: DOCUMENT_ID,
      mode: 'fit',
      elementIds: ['a', 'b'],
    })
  })

  test('says nothing at all when the batch was rejected', async () => {
    // A human must never be shown an edit that did not happen.
    const store = new FakeDocumentStore()
    await seedCanvas(store, EMPTY)
    const { activities, viewports, notifier } = makeNotifier()
    const tool = createCanvasEditTool({ ...makeDeps(store), clientNotifier: notifier })

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [
          { op: 'node.add', node: { id: 'a', type: 'text', text: 'A' } },
          { op: 'node.patch', id: 'ghost', patch: { x: 1 } },
        ],
      }),
    ).rejects.toMatchObject({ name: 'CanvasEditError' })

    expect(activities).toEqual([])
    expect(viewports).toEqual([])
  })

  test('follow:false reports the edit but leaves the viewport alone', async () => {
    // Moving someone's viewport is an interruption. It stays opt-out.
    const store = new FakeDocumentStore()
    await seedCanvas(store, EMPTY)
    const { activities, viewports, notifier } = makeNotifier()
    const tool = createCanvasEditTool({ ...makeDeps(store), clientNotifier: notifier })

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'node.add', node: { id: 'a', type: 'text', text: 'A' } }],
      follow: false,
    })

    expect(activities).toHaveLength(1)
    expect(viewports).toEqual([])
  })

  test('does not move the viewport when the batch touched no node', async () => {
    // `mode: 'fit'` with an empty elementIds list fits the WHOLE board,
    // which is a jarring jump for an edit that only removed an edge.
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [
        { id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'A' },
        { id: 'b', type: 'text', x: 50, y: 0, width: 10, height: 10, text: 'B' },
      ],
      edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
    })
    const { activities, viewports, notifier } = makeNotifier()
    const tool = createCanvasEditTool({ ...makeDeps(store), clientNotifier: notifier })

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'edge.remove', id: 'e' }],
    })

    expect(activities).toHaveLength(1)
    expect(activities[0].touched).toEqual({ nodes: [], edges: ['e'], comments: [] })
    expect(viewports).toEqual([])
  })

  test('applies identically with no notifier wired at all', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, EMPTY)
    const tool = createCanvasEditTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'node.add', node: { id: 'a', type: 'text', text: 'A' } }],
    })

    expect(result.applied).toBe(1)
  })

  test('a notifier that throws does not fail the batch that already landed', async () => {
    // The write is committed by the time anyone is told. Letting a broken
    // socket surface as a tool error would tell the agent its edit failed
    // when the edit is on disk.
    const store = new FakeDocumentStore()
    await seedCanvas(store, EMPTY)
    const tool = createCanvasEditTool({
      ...makeDeps(store),
      clientNotifier: {
        agentActivity: () => {
          throw new Error('socket exploded')
        },
        versionCreated: () => {},
        restoreProgress: () => {},
        requestViewport: async () => {
          throw new Error('socket exploded')
        },
      },
    })

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'node.add', node: { id: 'a', type: 'text', text: 'A' } }],
    })

    expect(result.applied).toBe(1)
    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.nodes.map((n) => n.id)).toEqual(['a'])
  })
})

/**
 * `region.set` — the one declarative op. "This group contains exactly these",
 * which makes it the only op that deletes something it was not told about.
 *
 * It names MEMBERS, by id, and nothing else: a node inside the group that is
 * not listed is removed, a listed node that is elsewhere is moved in and
 * placed, and a node that does not exist is `node.add`'s job (with `within`
 * to land it inside). The shape used to carry a full node declaration per
 * member — the node union a second time, a third of the tool's bytes — and
 * the lane showed what a model did with it: wrote x/y/width/height for every
 * box, including the ones already there.
 *
 * Its scope rule is STRICT containment, and that is what makes the boundary
 * safe rather than a judgement call: a node straddling the group's edge — a
 * human mid-drag, exactly the case that deferred this op — is not enclosed,
 * so it is out of scope and survives untouched.
 */
describe('wb_canvas_edit — region.set', () => {
  const GROUP = {
    id: 'g',
    type: 'group' as const,
    x: 0,
    y: 0,
    width: 500,
    height: 500,
    label: 'Phase 1',
  }

  test('removes what is inside the group and unlisted, and leaves the rest of the board alone', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [
        GROUP,
        { id: 'inside-old', type: 'text', x: 20, y: 20, width: 80, height: 40, text: 'old' },
        { id: 'outside', type: 'text', x: 900, y: 900, width: 80, height: 40, text: 'elsewhere' },
      ],
      edges: [],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        { op: 'node.add', node: { id: 'inside-new', type: 'text', text: 'new' }, within: 'g' },
        { op: 'region.set', within: 'g', nodes: ['inside-new'] },
      ],
    })

    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.nodes.map((n) => n.id).sort()).toEqual(['g', 'inside-new', 'outside'])
    expect(result.touched.nodes).toContain('inside-old')
    expect(result.touched.nodes).toContain('inside-new')
    expect(result.touched.nodes).not.toContain('outside')
  })

  test('does not touch a node straddling the boundary — the mid-drag case', async () => {
    // Only STRICT containment is in scope. This is the whole reason the op
    // is safe to hand an agent while a human is dragging.
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [
        GROUP,
        // Half in, half out: x+width = 540 > the group's 500.
        { id: 'straddling', type: 'text', x: 460, y: 20, width: 80, height: 40, text: 'moving' },
      ],
      edges: [],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'region.set', within: 'g', nodes: [] }],
    })

    expect(result.touched.nodes).not.toContain('straddling')
    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.nodes.map((n) => n.id).sort()).toEqual(['g', 'straddling'])
  })

  test('leaves a straddling node where it is even when listed', async () => {
    // Listed but not enclosed would otherwise mean "elsewhere, move it in"
    // — and a node across the boundary is the mid-drag case the scope rule
    // exists to protect. It is neither moved nor removed; it is left.
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [
        GROUP,
        { id: 'straddling', type: 'text', x: 460, y: 20, width: 80, height: 40, text: 'moving' },
      ],
      edges: [],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'region.set', within: 'g', nodes: ['straddling'] }],
    })

    expect(result.touched.nodes).not.toContain('straddling')
    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.nodes.find((node) => node.id === 'straddling')).toMatchObject({ x: 460, y: 20 })
  })

  test('never deletes the group it is scoped to', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, { nodes: [GROUP], edges: [] })
    const tool = createCanvasEditTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'region.set', within: 'g', nodes: [] }],
    })

    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.nodes.map((n) => n.id)).toEqual(['g'])
  })

  test('keeps an edge that leaves the region, and drops one stranded by a removed node', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [
        GROUP,
        { id: 'a', type: 'text', x: 20, y: 20, width: 80, height: 40, text: 'a' },
        { id: 'b', type: 'text', x: 200, y: 20, width: 80, height: 40, text: 'b' },
        { id: 'far', type: 'text', x: 900, y: 900, width: 80, height: 40, text: 'far' },
      ],
      edges: [
        { id: 'internal', fromNode: 'a', toNode: 'b' },
        { id: 'leaving', fromNode: 'a', toNode: 'far' },
      ],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      // 'a' survives (listed); 'b' does not; so 'internal' has nothing to
      // connect and goes with it, while 'leaving' is out of scope.
      ops: [{ op: 'region.set', within: 'g', nodes: ['a'] }],
    })

    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.edges.map((e) => e.id)).toEqual(['leaving'])
  })

  test('with `edges` given, keeps exactly those among the members', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [
        GROUP,
        { id: 'a', type: 'text', x: 20, y: 20, width: 80, height: 40, text: 'a' },
        { id: 'b', type: 'text', x: 200, y: 20, width: 80, height: 40, text: 'b' },
        { id: 'far', type: 'text', x: 900, y: 900, width: 80, height: 40, text: 'far' },
      ],
      edges: [
        { id: 'keep', fromNode: 'a', toNode: 'b' },
        { id: 'drop', fromNode: 'b', toNode: 'a' },
        { id: 'leaving', fromNode: 'a', toNode: 'far' },
      ],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'region.set', within: 'g', nodes: ['a', 'b'], edges: ['keep'] }],
    })

    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.edges.map((e) => e.id).sort()).toEqual(['keep', 'leaving'])
  })

  test('refuses when a locked node is inside the region', async () => {
    // A lock binds every op, and this one deletes by omission — silently
    // dropping a locked node would be the worst possible reading of it.
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [
        GROUP,
        { id: 'pinned', type: 'text', x: 20, y: 20, width: 80, height: 40, text: 'pinned' },
      ],
      edges: [],
    })
    const tool = createCanvasEditTool(makeDeps(store))
    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'node.lock', id: 'pinned', locked: true }],
    })

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [{ op: 'region.set', within: 'g', nodes: [] }],
      }),
    ).rejects.toMatchObject({ name: 'CanvasEditError', opIndex: 0 })

    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.nodes.map((n) => n.id).sort()).toEqual(['g', 'pinned'])
  })

  test('moves a listed node that is elsewhere into the group, and is idempotent', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [
        GROUP,
        { id: 'one', type: 'text', x: 900, y: 900, width: 80, height: 40, text: 'one' },
      ],
      edges: [],
    })
    const tool = createCanvasEditTool(makeDeps(store))
    const op = { op: 'region.set' as const, within: 'g', nodes: ['one'] }

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [op],
    })
    const moved = result.geometry.find((entry) => entry.id === 'one')
    expect(moved).toBeDefined()
    expect(moved?.x).toBeGreaterThanOrEqual(GROUP.x)
    expect(moved?.y).toBeGreaterThanOrEqual(GROUP.y)
    expect((moved?.x ?? 0) + (moved?.width ?? 0)).toBeLessThanOrEqual(GROUP.x + GROUP.width)
    expect((moved?.y ?? 0) + (moved?.height ?? 0)).toBeLessThanOrEqual(GROUP.y + GROUP.height)
    expect(result.touched.nodes).toContain('one')

    const before = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    const again = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [op],
    })
    const after = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(after.canvas).toEqual(before.canvas)
    expect(again.touched.nodes).toEqual([])
  })

  test('refuses to move in a locked node, and refuses a member that does not exist', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [
        GROUP,
        { id: 'outsider', type: 'text', x: 900, y: 900, width: 10, height: 10, text: 'keep me' },
      ],
      edges: [],
    })
    const tool = createCanvasEditTool(makeDeps(store))
    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'node.lock', id: 'outsider', locked: true }],
    })

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [{ op: 'region.set', within: 'g', nodes: ['outsider'] }],
      }),
    ).rejects.toMatchObject({
      name: 'CanvasEditError',
      opIndex: 0,
      message: expect.stringMatching(/locked/),
    })
    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.nodes.find((node) => node.id === 'outsider')).toMatchObject({ x: 900, y: 900 })

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [{ op: 'region.set', within: 'g', nodes: ['ghost'] }],
      }),
    ).rejects.toMatchObject({
      name: 'CanvasEditError',
      opIndex: 0,
      // The way out is named: a member that does not exist is created by
      // node.add, and `within` lands it inside.
      message: expect.stringMatching(/node\.add.*within/),
    })
  })

  test('refuses a `within` that is not a group on the canvas', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [
        { id: 'plain', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'not a group' },
      ],
      edges: [],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [{ op: 'region.set', within: 'plain', nodes: [] }],
      }),
    ).rejects.toMatchObject({ name: 'CanvasEditError', opIndex: 0 })

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [{ op: 'region.set', within: 'ghost', nodes: [] }],
      }),
    ).rejects.toMatchObject({ name: 'CanvasEditError', opIndex: 0 })
  })

  // `touchedEdges` accumulates across the WHOLE batch, so using it as the
  // region's own deletion set makes an earlier op's edge collateral damage.
  test('leaves an edge an earlier op touched alone when it is nowhere near the region', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [
        GROUP,
        { id: 'far1', type: 'text', x: 900, y: 900, width: 10, height: 10, text: 'far' },
        { id: 'far2', type: 'text', x: 900, y: 940, width: 10, height: 10, text: 'far' },
      ],
      edges: [],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        // Touches `outside` — and this edge is nowhere near `g`.
        { op: 'edge.add', edge: { id: 'outside', fromNode: 'far1', toNode: 'far2' } },
        { op: 'region.set', within: 'g', nodes: [] },
      ],
    })

    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.edges.map((edge) => edge.id)).toEqual(['outside'])
  })

  test('refuses a listed edge whose endpoints are not both members', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [
        GROUP,
        { id: 'in', type: 'text', x: 20, y: 20, width: 10, height: 10, text: 'in' },
        { id: 'far', type: 'text', x: 900, y: 900, width: 10, height: 10, text: 'far' },
      ],
      edges: [{ id: 'smuggled', fromNode: 'in', toNode: 'far' }],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [{ op: 'region.set', within: 'g', nodes: ['in'], edges: ['smuggled'] }],
      }),
    ).rejects.toMatchObject({ name: 'CanvasEditError', opIndex: 0 })

    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.edges.map((edge) => edge.id)).toEqual(['smuggled'])
  })
})

/**
 * `node.add` with `within`: the node lands INSIDE that group, placed around
 * what the group already holds, and the group grows when it has no room.
 * This is where a member of a region is created; `region.set` only names
 * members.
 *
 * Placement is what makes geometry optional, and a placement that landed
 * outside the group used to refuse the whole batch — the third default-size
 * box in a 700-wide group wraps to a row that does not fit. Measured on the
 * lane: a model then declares full geometry for every box instead, which is
 * the arithmetic the optional geometry exists to spare it.
 */
describe('wb_canvas_edit — node.add within a group', () => {
  const GROUP = {
    id: 'g',
    type: 'group' as const,
    x: 0,
    y: 0,
    width: 500,
    height: 500,
    label: 'Phase 1',
  }

  test('places a node that carries no geometry inside the group', async () => {
    // The default placement puts a node below existing content, which would
    // land it outside the very group it was meant for.
    const store = new FakeDocumentStore()
    await seedCanvas(store, { nodes: [GROUP], edges: [] })
    const tool = createCanvasEditTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        {
          op: 'node.add',
          node: { id: 'fresh', type: 'text', text: 'no coordinates' },
          within: 'g',
        },
      ],
    })

    const placed = result.geometry.find((entry) => entry.id === 'fresh')
    expect(placed).toBeDefined()
    expect(placed?.x).toBeGreaterThanOrEqual(GROUP.x)
    expect(placed?.y).toBeGreaterThanOrEqual(GROUP.y)
    expect((placed?.x ?? 0) + (placed?.width ?? 0)).toBeLessThanOrEqual(GROUP.x + GROUP.width)
    expect((placed?.y ?? 0) + (placed?.height ?? 0)).toBeLessThanOrEqual(GROUP.y + GROUP.height)
  })

  test('places a geometry-less node clear of what the group already holds', async () => {
    // The lane's fixture, and what the lane showed: the first placement in a
    // group started from the group's top-left as if it were empty, so a
    // third box landed on top of the first, and the model then spent a call
    // moving it. Placement has to see the nodes the group keeps.
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [
        { ...GROUP, x: 0, y: 600, width: 700, height: 300 },
        { id: 'cli', type: 'text', x: 40, y: 700, width: 200, height: 80, text: 'CLI' },
        { id: 'web', type: 'text', x: 300, y: 700, width: 200, height: 80, text: 'Web app' },
      ],
      edges: [],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        {
          op: 'node.add',
          node: { id: 'mobile', type: 'text', text: 'Mobile app', width: 200, height: 80 },
          within: 'g',
        },
      ],
    })

    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    const byId = new Map(canvas.nodes.map((node) => [node.id, node]))
    const mobile = byId.get('mobile')
    const group = byId.get('g')
    if (mobile === undefined || group === undefined) throw new Error('unreachable')
    const overlaps = (a: SpatialNode, b: SpatialNode) =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
    for (const id of ['cli', 'web']) {
      const kept = byId.get(id)
      if (kept === undefined) throw new Error('unreachable')
      expect(overlaps(mobile, kept)).toBe(false)
    }
    expect(mobile.x).toBeGreaterThanOrEqual(group.x)
    expect(mobile.x + mobile.width).toBeLessThanOrEqual(group.x + group.width)
    expect(mobile.y + mobile.height).toBeLessThanOrEqual(group.y + group.height)
    // It fit in the room the group had, so the group did not grow.
    expect(group).toMatchObject({ width: 700, height: 300 })
  })

  test('grows the group to hold the nodes it placed inside it', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      // Narrower AND shorter than one default-size box, so both axes grow.
      nodes: [{ ...GROUP, width: 200, height: 100 }],
      edges: [],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: ['a', 'b', 'c'].map((id) => ({
        op: 'node.add' as const,
        node: { id, type: 'text' as const, text: id.toUpperCase() },
        within: 'g',
      })),
    })

    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    const group = canvas.nodes.find((node) => node.id === 'g')
    expect(group).toBeDefined()
    if (group === undefined) throw new Error('unreachable')
    for (const id of ['a', 'b', 'c']) {
      const node = canvas.nodes.find((candidate) => candidate.id === id)
      expect(node).toBeDefined()
      if (node === undefined) throw new Error('unreachable')
      expect(node.x).toBeGreaterThanOrEqual(group.x)
      expect(node.y).toBeGreaterThanOrEqual(group.y)
      expect(node.x + node.width).toBeLessThanOrEqual(group.x + group.width)
      expect(node.y + node.height).toBeLessThanOrEqual(group.y + group.height)
    }
    // Grown, not replaced: the group's own position and label survive.
    expect(group).toMatchObject({ x: 0, y: 0, label: 'Phase 1' })
    expect(group.width).toBeGreaterThan(200)
    expect(group.height).toBeGreaterThan(100)
    // A grown group is a changed node, and its new size is reported the way
    // a placed node's position is.
    expect(result.touched.nodes).toContain('g')
    expect(result.geometry.find((entry) => entry.id === 'g')).toMatchObject({
      width: group.width,
      height: group.height,
    })
  })

  test('refuses to grow a locked group, and says so', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [{ ...GROUP, width: 200, height: 100 }],
      edges: [],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [
          { op: 'node.lock', id: 'g', locked: true },
          { op: 'node.add', node: { id: 'a', type: 'text', text: 'A' }, within: 'g' },
        ],
      }),
    ).rejects.toMatchObject({
      name: 'CanvasEditError',
      opIndex: 1,
      message: expect.stringMatching(/locked/),
    })
  })

  test('grows the group for a node given a position past its right edge', async () => {
    // What the lane did with `within` the moment it existed: named the group
    // AND wrote the next slot in the row, 560 in a group 700 wide, three
    // trials of three — and the description had promised the group grows
    // to fit. Both intentions are explicit, and growing satisfies both.
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [{ ...GROUP, x: 0, y: 600, width: 700, height: 300 }],
      edges: [],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        {
          op: 'node.add',
          node: {
            id: 'mobile',
            type: 'text',
            x: 560,
            y: 700,
            width: 200,
            height: 80,
            text: 'Mobile',
          },
          within: 'g',
        },
      ],
    })

    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.nodes.find((node) => node.id === 'mobile')).toMatchObject({ x: 560, y: 700 })
    expect(canvas.nodes.find((node) => node.id === 'g')).toMatchObject({
      x: 0,
      y: 600,
      width: 800,
      height: 300,
    })
    expect(result.touched.nodes).toContain('g')
    expect(result.geometry.find((entry) => entry.id === 'g')).toMatchObject({ width: 800 })
  })

  test("a node given a position before the group's top-left is refused with the edge and the way out", async () => {
    // The top-left is the one thing growth keeps, so this is the caller's
    // to move — and the text says which edge, by how much, and how.
    const store = new FakeDocumentStore()
    await seedCanvas(store, { nodes: [GROUP], edges: [] })
    const tool = createCanvasEditTool(makeDeps(store))
    const attempt = () =>
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [
          {
            op: 'node.add',
            node: {
              id: 'early',
              type: 'text',
              x: -30,
              y: 20,
              width: 200,
              height: 40,
              text: 'early',
            },
            within: 'g',
          },
        ],
      })

    await expect(attempt()).rejects.toMatchObject({
      name: 'CanvasEditError',
      opIndex: 0,
      message: expect.stringMatching(/left edge -30 .*0/),
    })
    await expect(attempt()).rejects.toThrow(/move the node|omit its x\/y/)
    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.nodes.map((node) => node.id)).toEqual(['g'])
  })

  test('refuses to grow into a neighbour, and names it', async () => {
    // Growth that swallows a node just past the old edge makes that node a
    // member the next region.set deletes by omission. So a group never
    // grows over something it did not already overlap; the refusal says
    // which node is in the way.
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [
        { ...GROUP, width: 200, height: 100 },
        { id: 'neighbour', type: 'text', x: 220, y: 20, width: 80, height: 40, text: 'next door' },
      ],
      edges: [],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [
          {
            op: 'node.add',
            node: { id: 'wide', type: 'text', x: 150, y: 20, width: 100, height: 40, text: 'wide' },
            within: 'g',
          },
        ],
      }),
    ).rejects.toMatchObject({
      name: 'CanvasEditError',
      opIndex: 0,
      message: expect.stringMatching(/"neighbour"/),
    })
    // The placed path hits the same wall: three default boxes in a 200x100
    // group grow it right and down, and the neighbour sits to the right.
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [{ op: 'node.add', node: { id: 'a', type: 'text', text: 'A' }, within: 'g' }],
      }),
    ).rejects.toThrow(/"neighbour"/)
    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.nodes.find((node) => node.id === 'g')).toMatchObject({ width: 200, height: 100 })
  })

  test('refuses a `within` that is not a group', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [{ id: 'plain', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'plain' }],
      edges: [],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [{ op: 'node.add', node: { id: 'a', type: 'text', text: 'A' }, within: 'plain' }],
      }),
    ).rejects.toMatchObject({ name: 'CanvasEditError', opIndex: 0 })
  })
})

/**
 * A SELECTOR where an id goes: `within` (every node inside a group) or
 * `all` (every node on the canvas) on the ops that take one target. Measured
 * before it existed: "colour every box inside the Clients group" and "lock
 * every item on the roadmap" each cost a read the errand did not need — the
 * snapshot was there only to learn the ids the edit would name. A selector
 * lets the edit name the condition instead.
 */
describe('wb_canvas_edit — a selector where an id goes', () => {
  const GROUP = { id: 'g', type: 'group' as const, x: 0, y: 0, width: 500, height: 500 }
  const BOARD = {
    nodes: [
      GROUP,
      { id: 'a', type: 'text' as const, x: 20, y: 20, width: 80, height: 40, text: 'a' },
      { id: 'b', type: 'text' as const, x: 200, y: 20, width: 80, height: 40, text: 'b' },
      { id: 'far', type: 'text' as const, x: 900, y: 900, width: 80, height: 40, text: 'far' },
    ],
    edges: [
      { id: 'ab', fromNode: 'a', toNode: 'b' },
      { id: 'bfar', fromNode: 'b', toNode: 'far' },
    ],
  }

  test('node.patch with `within` patches every node inside the group and nothing else', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, BOARD)
    const tool = createCanvasEditTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'node.patch', within: 'g', patch: { color: '5' } }],
    })

    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    const colour = (id: string) => canvas.nodes.find((node) => node.id === id)?.color
    expect([colour('a'), colour('b')]).toEqual(['5', '5'])
    expect(colour('far')).toBeUndefined()
    expect(colour('g')).toBeUndefined()
    expect(result.touched.nodes.sort()).toEqual(['a', 'b'])
  })

  test('node.lock with `all` locks every node on the canvas', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, BOARD)
    const tool = createCanvasEditTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [{ op: 'node.lock', all: true, locked: true }],
    })

    const snapshot = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'edge.lock', within: 'g', locked: true }],
    })
    expect(snapshot.snapshot.nodes.every((node) => node.locked === true)).toBe(true)
    // `within` on an edge op means both ends inside: `ab` yes, `bfar` no.
    expect(snapshot.snapshot.edges.find((edge) => edge.id === 'ab')?.locked).toBe(true)
    expect(snapshot.snapshot.edges.find((edge) => edge.id === 'bfar')?.locked).toBeUndefined()
  })

  test('a selector that matches nothing is refused, so an errand cannot silently do nothing', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, { nodes: [GROUP], edges: [] })
    const tool = createCanvasEditTool(makeDeps(store))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [{ op: 'node.patch', within: 'g', patch: { color: '5' } }],
      }),
    ).rejects.toMatchObject({
      name: 'CanvasEditError',
      opIndex: 0,
      message: expect.stringMatching(/no node is inside "g"/),
    })
  })

  test('a locked member refuses the whole selection, by name', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, BOARD)
    const tool = createCanvasEditTool(makeDeps(store))
    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [{ op: 'node.lock', id: 'b', locked: true }],
    })

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [{ op: 'node.remove', within: 'g' }],
      }),
    ).rejects.toMatchObject({
      name: 'CanvasEditError',
      opIndex: 0,
      message: expect.stringMatching(/node "b" is locked/),
    })
    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.nodes.map((node) => node.id).sort()).toEqual(['a', 'b', 'far', 'g'])
  })

  test('tidy with `within` moves only what is inside the group', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, BOARD)
    const tool = createCanvasEditTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'tidy', within: 'g' }],
    })

    expect(result.touched.nodes).not.toContain('far')
    expect(result.touched.nodes).not.toContain('g')
  })

  test('exactly one of id, within and all, at the schema', () => {
    const tool = createCanvasEditTool(makeDeps(new FakeDocumentStore()))
    const parse = (op: Record<string, unknown>) =>
      tool.inputSchema.safeParse({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, ops: [op] })
    expect(parse({ op: 'node.lock', locked: true }).success).toBe(false)
    expect(parse({ op: 'node.lock', id: 'a', all: true, locked: true }).success).toBe(false)
    expect(parse({ op: 'node.lock', within: 'g', locked: true }).success).toBe(true)
    expect(parse({ op: 'edge.remove', all: true }).success).toBe(true)
    expect(parse({ op: 'tidy', scope: ['a'], within: 'g' }).success).toBe(false)
  })
})

/**
 * The last gap in "content stays inside its frame": a node created without a
 * height got a fixed default, so an agent that did not invent geometry got a
 * box its own text did not fit. The fade and `overflows` report that
 * afterwards; this is about not producing it in the first place.
 */
const DEFAULT_TEXT_HEIGHT = 120

describe('wb_canvas_edit — a node created without a height', () => {
  // Long enough to need 176px in a 260-wide box, against the 120px default.
  // One repetition measures 96px and FITS — a fixture that short would pass
  // against the unfixed code and assert nothing, which is why the first test
  // below re-checks that it is still reaching the case.
  const LONG_JA = (
    'これは日本語の長い文章です。ノードの幅を超えても折り返されるべきですが、' +
    '既定の高さのままだと入りきりません。だから作るときに測ります。'
  ).repeat(2)

  async function addAndMeasure(text: string, height?: number) {
    const store = new FakeDocumentStore()
    await seedCanvas(store, EMPTY)
    const tool = createCanvasEditTool(makeDeps(store))
    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        {
          op: 'node.add',
          node: { id: 'n', type: 'text', text, ...(height === undefined ? {} : { height }) },
        },
      ],
    })
    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    const node = canvas.nodes[0]
    const natural = naturalNodeContentSize(node, {
      measure: constantRatioMeasureText,
      appearance: createSpatialTheme({ mode: 'light' }),
    })
    return { node, needs: natural.h + 2 * SPATIAL_THEME_GEOMETRY.paddingPx }
  }

  test('is tall enough for its own text', async () => {
    const { node, needs } = await addAndMeasure(LONG_JA)

    // The fixture has to out-grow the default, or this asserts nothing.
    expect(needs).toBeGreaterThan(DEFAULT_TEXT_HEIGHT)
    // EXACTLY what it needs. A lower bound would also accept extra height,
    // and height is placement geometry — a node taller than its content
    // pushes whatever the cursor lays out after it.
    expect(node.height).toBe(needs)
  })

  test('respects a height that was named, however small', async () => {
    // "no height" and "a small height" are different inputs. Someone who
    // asked for 40 gets 40 — the fade is the honest answer there.
    const { node } = await addAndMeasure(LONG_JA, 40)

    expect(node.height).toBe(40)
  })

  test('does not shrink a short node below the default', async () => {
    // Grow-only. A one-word node measuring 32px tall would still look wrong
    // next to its neighbours, and nothing about the defect asks for that.
    const { node } = await addAndMeasure('short')

    expect(node.height).toBe(DEFAULT_TEXT_HEIGHT)
  })
})

describe('node.patch and a node type that does not have the key', () => {
  const TEXT_NODE = {
    id: 'n1',
    type: 'text' as const,
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    text: 'hello',
  }

  test("refuses a key the target node's type does not have, rather than dropping it", async () => {
    // `label` is on the patch allowlist because a GROUP has one. A text node
    // does not, and the per-type schemas are non-strict, so the merge's
    // re-parse strips the key and the write reports success over a document
    // it did not change. Named, because a silent no-op is the one failure a
    // caller cannot see.
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    await seedCanvas(store, { nodes: [TEXT_NODE], edges: [] })

    await expect(
      createCanvasEditTool(makeDeps(store)).execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [{ op: 'node.patch', id: 'n1', patch: { label: 'a label' } }],
      }),
    ).rejects.toMatchObject({
      name: 'CanvasEditError',
      opIndex: 0,
      // The message has to name BOTH the key and the type: "label is not
      // valid" leaves a caller guessing which of its nodes was wrong.
      message: expect.stringMatching(/label/),
    })
    await expect(
      createCanvasEditTool(makeDeps(store)).execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [{ op: 'node.patch', id: 'n1', patch: { label: 'a label' } }],
      }),
    ).rejects.toThrow(/text/)
  })

  test('the INPUT SCHEMA accepts every per-type content key, and only those', () => {
    // The schema is where the MCP boundary validates (document-tools.ts
    // parses before execute), so `execute` alone does not exercise it —
    // measured: removing `text` from nodePatchFieldsSchema left every
    // behavioural test in this file green, because they call execute
    // directly. This is the test that fails for that.
    const patch = (fields: Record<string, unknown>) =>
      canvasEditInputSchema.safeParse({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [{ op: 'node.patch', id: 'n1', patch: fields }],
      }).success

    expect(patch({ text: 'a text node' })).toBe(true)
    expect(patch({ file: 'a/file.md' })).toBe(true)
    expect(patch({ subpath: '#heading' })).toBe(true)
    expect(patch({ url: 'https://example.com' })).toBe(true)
    expect(patch({ label: 'a group' })).toBe(true)
    expect(patch({ background: 'a/bg.png' })).toBe(true)
    expect(patch({ backgroundStyle: 'cover' })).toBe(true)

    // A patch changes what a node SAYS, never which node it is or what
    // kind — so these two stay out however wide the content half gets.
    expect(patch({ id: 'renamed' })).toBe(false)
    expect(patch({ type: 'group' })).toBe(false)
    // `.strict()`, so an invented key is refused at the boundary rather
    // than reaching the drop guard.
    expect(patch({ nonsense: 1 })).toBe(false)
    // Still validated, not just allowed through.
    expect(patch({ subpath: 'no-hash' })).toBe(false)
    expect(patch({ url: 'not-a-url' })).toBe(false)
  })

  test('the INPUT SCHEMA accepts node.splice and checks its range', () => {
    const splice = (fields: Record<string, unknown>) =>
      canvasEditInputSchema.safeParse({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [{ op: 'node.splice', id: 'n1', ...fields }],
      }).success

    expect(splice({ startLine: 0, endLine: 2, replacement: 'x' })).toBe(true)
    expect(splice({ startLine: 2, endLine: 0, replacement: 'x' })).toBe(false)
    expect(splice({ startLine: -1, endLine: 0, replacement: 'x' })).toBe(false)
    expect(splice({ startLine: 0, endLine: 0 })).toBe(false)
  })

  test("changes a text node's text, which is what retires wb_body_patch", async () => {
    // The capability wb_body_patch(mode:'full') had and node.patch did not.
    // It arrives as an ordinary op, so it batches with the rest of a
    // drawing AND falls under wb_canvas_edit's propose-by-default rule —
    // which wb_body_patch, having no propose mode, escaped entirely.
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    await seedCanvas(store, { nodes: [TEXT_NODE], edges: [] })

    await createCanvasEditTool(makeDeps(store)).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'node.patch', id: 'n1', patch: { text: '# Rewritten' } }],
    })

    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.nodes[0]).toMatchObject({ type: 'text', text: '# Rewritten' })
  })

  test('several nodes change their text in ONE call', async () => {
    // wb_body_patch took one nodeId, so three nodes were three calls. The
    // ops array is the axis-A answer the tool already had.
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    await seedCanvas(store, {
      nodes: [
        TEXT_NODE,
        { ...TEXT_NODE, id: 'n2', text: 'second' },
        { ...TEXT_NODE, id: 'n3', text: 'third' },
      ],
      edges: [],
    })

    await createCanvasEditTool(makeDeps(store)).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        { op: 'node.patch', id: 'n1', patch: { text: 'one' } },
        { op: 'node.patch', id: 'n2', patch: { text: 'two' } },
        { op: 'node.patch', id: 'n3', patch: { text: 'three' } },
      ],
    })

    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.nodes.map((node) => (node.type === 'text' ? node.text : undefined))).toEqual([
      'one',
      'two',
      'three',
    ])
  })

  test('splices a line range of a text node, one op per node', async () => {
    // wb_body_patch(mode:'range')'s job, as an op. A caller editing one line
    // of a long body sends that line rather than the whole text, and — the
    // part wb_body_patch could not do — several nodes in one call.
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    await seedCanvas(store, {
      nodes: [
        { ...TEXT_NODE, text: 'one\ntwo\nthree' },
        { ...TEXT_NODE, id: 'n2', text: 'alpha\nbeta' },
      ],
      edges: [],
    })

    await createCanvasEditTool(makeDeps(store)).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        { op: 'node.splice', id: 'n1', startLine: 1, endLine: 1, replacement: 'TWO' },
        { op: 'node.splice', id: 'n2', startLine: 0, endLine: 0, replacement: 'A\nB' },
      ],
    })

    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.nodes.map((node) => (node.type === 'text' ? node.text : undefined))).toEqual([
      'one\nTWO\nthree',
      'A\nB\nbeta',
    ])
  })

  test('refuses a line range past the end rather than clamping it', async () => {
    // Clamping would partial-apply the splice without saying so, which is
    // the failure the codec's own parsers refuse to degrade into.
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    await seedCanvas(store, { nodes: [{ ...TEXT_NODE, text: 'one\ntwo' }], edges: [] })

    await expect(
      createCanvasEditTool(makeDeps(store)).execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [{ op: 'node.splice', id: 'n1', startLine: 0, endLine: 5, replacement: 'x' }],
      }),
    ).rejects.toThrow(/2-line/)
  })

  test('refuses to splice a node that holds no text', async () => {
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    await seedCanvas(store, {
      nodes: [{ id: 'g1', type: 'group', x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    })

    await expect(
      createCanvasEditTool(makeDeps(store)).execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [{ op: 'node.splice', id: 'g1', startLine: 0, endLine: 0, replacement: 'x' }],
      }),
    ).rejects.toThrow(/group/)
  })

  test('a group takes the same key, since a group really has one', async () => {
    // The other side of the guard: `label` is refused BECAUSE of the target
    // type, not because the key is suspect.
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    await seedCanvas(store, {
      nodes: [{ id: 'g1', type: 'group', x: 0, y: 0, width: 100, height: 50 }],
      edges: [],
    })

    await createCanvasEditTool(makeDeps(store)).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'node.patch', id: 'g1', patch: { label: 'a label' } }],
    })

    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.nodes[0]).toMatchObject({ label: 'a label' })
  })
})

describe('the node extension on the write side', () => {
  // The stored schema `.catch`es a broken extension so a canvas stays
  // readable; a WRITER sending one is told, not silently stripped.
  test('refuses an embed that names no document, by name', () => {
    const result = canvasEditInputSchema.safeParse({
      workspaceId: 'ws',
      documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7',
      ops: [
        {
          op: 'node.add',
          node: { id: 'n', type: 'text', text: 'x', 'x-whiteboard': { kind: 'embed' } },
        },
      ],
    })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('an embed names the document')
  })

  test('narrows a flat extension to the stored shape: an embed, or facets alone', () => {
    const parse = (extension: Record<string, unknown>) =>
      canvasEditInputSchema.parse({
        workspaceId: 'ws',
        documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7',
        ops: [{ op: 'node.add', node: { type: 'text', text: 'x', 'x-whiteboard': extension } }],
      }).ops[0]
    const embed = parse({ kind: 'embed', documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V8' })
    expect(embed.op === 'node.add' && embed.node['x-whiteboard']).toEqual({
      kind: 'embed',
      documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V8',
    })
    const facets = parse({ facets: { 'example.kanban/v1': { status: 'todo' } } })
    expect(facets.op === 'node.add' && facets.node['x-whiteboard']).toEqual({
      facets: { 'example.kanban/v1': { status: 'todo' } },
    })
  })
})
