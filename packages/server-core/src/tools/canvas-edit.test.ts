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
import { loadDocument } from './document-io.js'

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
    ).rejects.toMatchObject({ name: 'DocumentNotFoundError' })
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
