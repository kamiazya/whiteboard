import {
  readDocumentKind,
  readEdgeLocks,
  readNodeLocks,
  writeDocumentKind,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, test } from 'vitest'
import type { AgentActivity, ViewportRequest } from '../server-deps.js'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import {
  canvasEditInputSchema,
  createCanvasEditTool,
  PLACEMENT_COLUMNS,
  PLACEMENT_GUTTER_PX,
} from './canvas-edit.js'
import { loadDocument } from './document-io.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

function makeDeps(documentStore: FakeDocumentStore) {
  return { documentStore, blobStore: {} as never, documentIndex: documentStore.documentIndex }
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
    expect(result.touched).toEqual({ nodes: ['a', 'b'], edges: ['e'] })
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

    const { canvas } = await loadDocument(makeDeps(store), DOCUMENT_ID)
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
      ops: [{ op: 'node.add', node: { id: 'free', type: 'text', text: 'no coordinates' } }],
    })

    const placed = result.geometry.find((entry) => entry.id === 'free')
    expect(placed).toBeDefined()
    // Below the existing content, never on top of it — an agent asked for a
    // node, not for the anchor to be covered up.
    expect(placed?.y).toBeGreaterThanOrEqual(50 + PLACEMENT_GUTTER_PX)
    expect(placed?.width).toBeGreaterThan(0)
    expect(placed?.height).toBeGreaterThan(0)

    const { canvas } = await loadDocument(makeDeps(store), DOCUMENT_ID)
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
      ops: [
        { op: 'node.patch', id: 'a', patch: { x: 7, color: '3' } },
        { op: 'edge.remove', id: 'e' },
        { op: 'node.remove', id: 'b' },
      ],
    })

    expect(result.touched).toEqual({ nodes: ['a', 'b'], edges: ['e'] })
    const { canvas } = await loadDocument(makeDeps(store), DOCUMENT_ID)
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
      ops: [{ op: 'node.remove', id: 'b' }],
    })

    expect(result.touched.edges).toEqual(['e'])
    const { canvas } = await loadDocument(makeDeps(store), DOCUMENT_ID)
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
      ops: [{ op: 'node.lock', id: 'a', locked: true }],
    })

    // A lock the batch itself set binds the ops after it, exactly as a lock
    // set in an earlier call does.
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
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
        ops: [{ op: 'node.patch', id: 'a', patch: { x: 1 } }],
      }),
    ).rejects.toMatchObject({ name: 'CanvasEditError', opIndex: 0 })

    // The rejected batch above must not have persisted its own lock on 'b'.
    const { doc } = await loadDocument(makeDeps(store), DOCUMENT_ID)
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
      ops: [{ op: 'node.lock', id: 'a', locked: true }],
    })
    // An agent has to be able to lift its own mistake without a human at
    // the keyboard (the rule the retired wb_node_lock established).
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [
        { op: 'node.lock', id: 'a', locked: false },
        { op: 'node.patch', id: 'a', patch: { x: 9 } },
      ],
    })

    expect(result.applied).toBe(2)
    const { doc, canvas } = await loadDocument(makeDeps(store), DOCUMENT_ID)
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
      ops: [{ op: 'edge.lock', id: 'e', locked: true }],
    })
    const { doc } = await loadDocument(makeDeps(store), DOCUMENT_ID)
    expect(readEdgeLocks(doc).has('e')).toBe(true)

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
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
    const { canvas } = await loadDocument(makeDeps(store), DOCUMENT_ID)
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
      ops: [{ op: 'node.add', node: { type: 'text', text: 'anonymous' } }],
    })

    expect(result.touched.nodes).toHaveLength(1)
    const minted = result.touched.nodes[0]
    expect(minted).toMatch(/\S/)
    const { canvas } = await loadDocument(makeDeps(store), DOCUMENT_ID)
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
      ops: [{ op: 'node.add', node: { id: 'a', type: 'text', text: 'A' } }],
    })

    const { doc } = await loadDocument(makeDeps(store), DOCUMENT_ID)
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
      ops: [{ op: 'node.patch', id: 'a', patch: { width: -1 } }],
    })
    expect(parsed.success).toBe(false)

    // A non-negative width still parses, so the rejection above is the
    // sign constraint and not the op shape.
    expect(
      canvasEditInputSchema.safeParse({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        ops: [{ op: 'node.patch', id: 'a', patch: { width: 1 } }],
      }).success,
    ).toBe(true)
  })

  test('drops a label patched onto a text node instead of storing it (from wb_node_patch)', async () => {
    // `label` is a group-only field and the per-type node schemas are not
    // strict, so an unrecognized key is stripped on re-parse rather than
    // rejected. Existing schema behaviour, pinned here because it is
    // surprising enough that a reader would otherwise call it a bug.
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'A' }],
      edges: [],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [{ op: 'node.patch', id: 'a', patch: { label: 'not for a text node' } }],
    })

    const { canvas } = await loadDocument(makeDeps(store), DOCUMENT_ID)
    expect(canvas.nodes[0]).not.toHaveProperty('label')
  })

  test('rejects an invalid arrowhead end at the schema level (from wb_edge_patch)', async () => {
    const parsed = canvasEditInputSchema.safeParse({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [{ op: 'edge.patch', id: 'e', patch: { toEnd: 'triangle' } }],
    })
    expect(parsed.success).toBe(false)

    const valid = canvasEditInputSchema.safeParse({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
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
      ops: [
        { op: 'node.lock', id: 'a', locked: true },
        // Only an edge's OWN lock stops it being patched.
        { op: 'edge.patch', id: 'e', patch: { label: 'still editable' } },
      ],
    })

    expect(result.applied).toBe(2)
    const { canvas } = await loadDocument(makeDeps(store), DOCUMENT_ID)
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
      ops: [
        { op: 'edge.lock', id: 'x', locked: true },
        { op: 'node.patch', id: 'x', patch: { x: 5 } },
      ],
    })

    expect(result.applied).toBe(2)
    const { doc, canvas } = await loadDocument(makeDeps(store), DOCUMENT_ID)
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
      ops: [{ op: 'node.lock', id: 'pinned', locked: true }, { op: 'tidy' }],
    })

    const { canvas } = await loadDocument(makeDeps(store), DOCUMENT_ID)
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
      ops: [{ op: 'tidy', scope: ['b'] }],
    })

    expect(result.geometry.every((entry) => entry.id === 'b')).toBe(true)
    const { canvas } = await loadDocument(makeDeps(store), DOCUMENT_ID)
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
      ops: [{ op: 'tidy' }],
    })
    const second = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [{ op: 'tidy' }],
    })

    expect(second.geometry).toEqual([])
    expect(second.touched).toEqual({ nodes: [], edges: [] })
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
      ops: [{ op: 'edge.remove', id: 'e' }],
    })

    expect(activities).toHaveLength(1)
    expect(activities[0].touched).toEqual({ nodes: [], edges: ['e'] })
    expect(viewports).toEqual([])
  })

  test('applies identically with no notifier wired at all', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, EMPTY)
    const tool = createCanvasEditTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
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
        requestViewport: async () => {
          throw new Error('socket exploded')
        },
      },
    })

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [{ op: 'node.add', node: { id: 'a', type: 'text', text: 'A' } }],
    })

    expect(result.applied).toBe(1)
    const { canvas } = await loadDocument(makeDeps(store), DOCUMENT_ID)
    expect(canvas.nodes.map((n) => n.id)).toEqual(['a'])
  })
})

/**
 * `region.set` — the one declarative op. "This group should look like this",
 * which makes it the only op that deletes something it was not told about.
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

  test('replaces what is inside the group and leaves the rest of the board alone', async () => {
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
      ops: [
        {
          op: 'region.set',
          within: 'g',
          nodes: [
            { id: 'inside-new', type: 'text', x: 20, y: 20, width: 80, height: 40, text: 'new' },
          ],
          edges: [],
        },
      ],
    })

    const { canvas } = await loadDocument(makeDeps(store), DOCUMENT_ID)
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
      ops: [{ op: 'region.set', within: 'g', nodes: [], edges: [] }],
    })

    expect(result.touched.nodes).not.toContain('straddling')
    const { canvas } = await loadDocument(makeDeps(store), DOCUMENT_ID)
    expect(canvas.nodes.map((n) => n.id).sort()).toEqual(['g', 'straddling'])
  })

  test('never deletes the group it is scoped to', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, { nodes: [GROUP], edges: [] })
    const tool = createCanvasEditTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [{ op: 'region.set', within: 'g', nodes: [], edges: [] }],
    })

    const { canvas } = await loadDocument(makeDeps(store), DOCUMENT_ID)
    expect(canvas.nodes.map((n) => n.id)).toEqual(['g'])
  })

  test('keeps an edge that leaves the region, and replaces one wholly inside it', async () => {
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
      ops: [
        {
          op: 'region.set',
          within: 'g',
          // 'a' survives (listed); 'b' does not; so 'internal' has nothing to
          // connect and goes with it, while 'leaving' is out of scope.
          nodes: [{ id: 'a', type: 'text', x: 20, y: 20, width: 80, height: 40, text: 'a' }],
          edges: [],
        },
      ],
    })

    const { canvas } = await loadDocument(makeDeps(store), DOCUMENT_ID)
    expect(canvas.edges.map((e) => e.id)).toEqual(['leaving'])
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
      ops: [{ op: 'node.lock', id: 'pinned', locked: true }],
    })

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        ops: [{ op: 'region.set', within: 'g', nodes: [], edges: [] }],
      }),
    ).rejects.toMatchObject({ name: 'CanvasEditError', opIndex: 0 })

    const { canvas } = await loadDocument(makeDeps(store), DOCUMENT_ID)
    expect(canvas.nodes.map((n) => n.id).sort()).toEqual(['g', 'pinned'])
  })

  test('places a listed node that carries no geometry INSIDE the group', async () => {
    // The default placement puts a node below existing content, which for
    // this op would land it outside the very region it was declared in — and
    // therefore out of scope on the next call, which is not idempotent.
    const store = new FakeDocumentStore()
    await seedCanvas(store, { nodes: [GROUP], edges: [] })
    const tool = createCanvasEditTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [
        {
          op: 'region.set',
          within: 'g',
          nodes: [{ id: 'fresh', type: 'text', text: 'no coordinates' }],
          edges: [],
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

  test('is idempotent: applying the same region twice changes nothing the second time', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, { nodes: [GROUP], edges: [] })
    const tool = createCanvasEditTool(makeDeps(store))
    const op = {
      op: 'region.set' as const,
      within: 'g',
      nodes: [{ id: 'one', type: 'text' as const, text: 'one' }],
      edges: [],
    }

    await tool.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, ops: [op] })
    const before = await loadDocument(makeDeps(store), DOCUMENT_ID)
    await tool.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, ops: [op] })
    const after = await loadDocument(makeDeps(store), DOCUMENT_ID)

    expect(after.canvas).toEqual(before.canvas)
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
        ops: [{ op: 'region.set', within: 'plain', nodes: [], edges: [] }],
      }),
    ).rejects.toMatchObject({ name: 'CanvasEditError', opIndex: 0 })

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        ops: [{ op: 'region.set', within: 'ghost', nodes: [], edges: [] }],
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
      ops: [
        // Touches `outside` — and this edge is nowhere near `g`.
        { op: 'edge.add', edge: { id: 'outside', fromNode: 'far1', toNode: 'far2' } },
        { op: 'region.set', within: 'g', nodes: [], edges: [] },
      ],
    })

    const { canvas } = await loadDocument(makeDeps(store), DOCUMENT_ID)
    expect(canvas.edges.map((edge) => edge.id)).toEqual(['outside'])
  })

  // The lock preflight only walks the region, so a declaration naming
  // something outside it is neither checked nor in scope — it would let a
  // region edit reach any node on the board, locked ones included.
  test('refuses to move a node that is not inside the region', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [
        GROUP,
        { id: 'outsider', type: 'text', x: 900, y: 900, width: 10, height: 10, text: 'keep me' },
      ],
      edges: [],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        ops: [
          {
            op: 'region.set',
            within: 'g',
            nodes: [
              {
                id: 'outsider',
                type: 'text',
                x: 950,
                y: 950,
                width: 10,
                height: 10,
                text: 'moved',
              },
            ],
            edges: [],
          },
        ],
      }),
    ).rejects.toMatchObject({ name: 'CanvasEditError', opIndex: 0 })

    const { canvas } = await loadDocument(makeDeps(store), DOCUMENT_ID)
    expect(canvas.nodes.find((node) => node.id === 'outsider')).toMatchObject({ x: 900, y: 900 })
  })

  test('refuses an edge whose endpoints are not both inside the region', async () => {
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

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        ops: [
          {
            op: 'region.set',
            within: 'g',
            nodes: [],
            edges: [{ id: 'smuggled', fromNode: 'far1', toNode: 'far2' }],
          },
        ],
      }),
    ).rejects.toMatchObject({ name: 'CanvasEditError', opIndex: 0 })

    const { canvas } = await loadDocument(makeDeps(store), DOCUMENT_ID)
    expect(canvas.edges).toEqual([])
  })
})
