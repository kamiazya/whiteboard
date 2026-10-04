// `region.set` of `wb_canvas_edit`: replace everything a group strictly encloses.

import type { SpatialNode } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, test } from 'vitest'
import { loadDocument } from '../document-io.js'
import { FakeDocumentStore } from '../test-utils/fake-document-store.js'
import { DOCUMENT_ID, EMPTY, makeDeps, seedCanvas, WORKSPACE_ID } from './_test-canvas-edit.js'
import { canvasEditInputSchema, createCanvasEditTool, PLACEMENT_GUTTER_PX } from './canvas-edit.js'

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
  const GROUP = groupNode({ id: 'g', x: 0, y: 0, width: 500, height: 500, label: 'Phase 1' })

  test('removes what is inside the group and unlisted, and leaves the rest of the board alone', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [
        GROUP,
        textNode({ id: 'inside-old', x: 20, y: 20, width: 80, height: 40, text: 'old' }),
        textNode({ id: 'outside', x: 900, y: 900, width: 80, height: 40, text: 'elsewhere' }),
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
        textNode({ id: 'straddling', x: 460, y: 20, width: 80, height: 40, text: 'moving' }),
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
        textNode({ id: 'straddling', x: 460, y: 20, width: 80, height: 40, text: 'moving' }),
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
        textNode({ id: 'a', x: 20, y: 20, width: 80, height: 40, text: 'a' }),
        textNode({ id: 'b', x: 200, y: 20, width: 80, height: 40, text: 'b' }),
        textNode({ id: 'far', x: 900, y: 900, width: 80, height: 40, text: 'far' }),
      ],
      edges: [
        {
          id: 'internal',
          from: { node: 'a' },
          to: { node: 'b' },
        },
        {
          id: 'leaving',
          from: { node: 'a' },
          to: { node: 'far' },
        },
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
        textNode({ id: 'a', x: 20, y: 20, width: 80, height: 40, text: 'a' }),
        textNode({ id: 'b', x: 200, y: 20, width: 80, height: 40, text: 'b' }),
        textNode({ id: 'far', x: 900, y: 900, width: 80, height: 40, text: 'far' }),
      ],
      edges: [
        {
          id: 'keep',
          from: { node: 'a' },
          to: { node: 'b' },
        },
        {
          id: 'drop',
          from: { node: 'b' },
          to: { node: 'a' },
        },
        {
          id: 'leaving',
          from: { node: 'a' },
          to: { node: 'far' },
        },
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
        textNode({ id: 'pinned', x: 20, y: 20, width: 80, height: 40, text: 'pinned' }),
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
      nodes: [GROUP, textNode({ id: 'one', x: 900, y: 900, width: 80, height: 40, text: 'one' })],
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
        textNode({ id: 'outsider', x: 900, y: 900, width: 10, height: 10, text: 'keep me' }),
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
      nodes: [textNode({ id: 'plain', x: 0, y: 0, width: 10, height: 10, text: 'not a group' })],
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
        textNode({ id: 'far1', x: 900, y: 900, width: 10, height: 10, text: 'far' }),
        textNode({ id: 'far2', x: 900, y: 940, width: 10, height: 10, text: 'far' }),
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
        {
          op: 'edge.add',
          edge: {
            id: 'outside',
            from: { node: 'far1' },
            to: { node: 'far2' },
          },
        },
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
        textNode({ id: 'in', x: 20, y: 20, width: 10, height: 10, text: 'in' }),
        textNode({ id: 'far', x: 900, y: 900, width: 10, height: 10, text: 'far' }),
      ],
      edges: [
        {
          id: 'smuggled',
          from: { node: 'in' },
          to: { node: 'far' },
        },
      ],
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

  test('a group added without a position is placed around the members it is set to, which stay put', async () => {
    // The lane's wrap-a-chain task: boxes drawn in a row, then a group
    // with no geometry, then region.set. The group used to land at the
    // cursor and pull the row into a column inside it; every trial then
    // spent two calls putting the boxes back and sizing the frame by hand.
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [textNode({ id: 'q3', x: 0, y: 0, width: 200, height: 80, text: 'Q3' })],
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
          node: { type: 'text', id: 'a', x: 0, y: 300, width: 200, height: 80, text: 'A' },
        },
        {
          op: 'node.add',
          node: { type: 'text', id: 'b', x: 300, y: 300, width: 200, height: 80, text: 'B' },
        },
        {
          op: 'node.add',
          node: { type: 'text', id: 'c', x: 600, y: 300, width: 200, height: 80, text: 'C' },
        },
        { op: 'node.add', node: { id: 'g', type: 'group', label: 'Pipeline' } },
        { op: 'region.set', within: 'g', nodes: ['a', 'b', 'c'] },
      ],
    })

    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    const at = (id: string) => {
      const n = canvas.nodes.find((node) => node.id === id) as SpatialNode
      return [n.x, n.y, n.width, n.height]
    }
    expect(at('a')).toEqual([0, 300, 200, 80])
    expect(at('b')).toEqual([300, 300, 200, 80])
    expect(at('c')).toEqual([600, 300, 200, 80])
    // The members' bounds plus the gutter on every side.
    expect(at('g')).toEqual([
      -PLACEMENT_GUTTER_PX,
      300 - PLACEMENT_GUTTER_PX,
      800 + 2 * PLACEMENT_GUTTER_PX,
      80 + 2 * PLACEMENT_GUTTER_PX,
    ])
    expect(result.geometry.find((entry) => entry.id === 'g')).toEqual({
      id: 'g',
      x: -PLACEMENT_GUTTER_PX,
      y: 300 - PLACEMENT_GUTTER_PX,
      width: 800 + 2 * PLACEMENT_GUTTER_PX,
      height: 80 + 2 * PLACEMENT_GUTTER_PX,
    })
  })

  test('a group placed around its members keeps a size it was given, and never a default one', async () => {
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
          node: { type: 'text', id: 'a', x: 100, y: 100, width: 200, height: 80, text: 'A' },
        },
        { op: 'node.add', node: { id: 'g', type: 'group', label: 'Wide', width: 1000 } },
        { op: 'region.set', within: 'g', nodes: ['a'] },
      ],
    })

    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    const g = canvas.nodes.find((node) => node.id === 'g') as SpatialNode
    expect([g.x, g.y, g.width, g.height]).toEqual([
      100 - PLACEMENT_GUTTER_PX,
      100 - PLACEMENT_GUTTER_PX,
      1000,
      80 + 2 * PLACEMENT_GUTTER_PX,
    ])
  })

  test('a group placed around its members refuses to swallow a bystander, naming it', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [
        textNode({ id: 'a', x: 0, y: 0, width: 200, height: 80, text: 'A' }),
        textNode({ id: 'between', x: 300, y: 0, width: 200, height: 80, text: 'not mine' }),
        textNode({ id: 'c', x: 600, y: 0, width: 200, height: 80, text: 'C' }),
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
          { op: 'node.add', node: { id: 'g', type: 'group', label: 'Pair' } },
          { op: 'region.set', within: 'g', nodes: ['a', 'c'] },
        ],
      }),
    ).rejects.toThrow(/"between"/)
  })

  test('a positioned member added within a group this batch placed at the cursor moves the group around it', async () => {
    // The node.add twin of the region.set case: the lane's layered board
    // added a group with no geometry and then its members, positioned and
    // within it; the group had landed at the cursor and the member was
    // refused as "before the group's top-left". Each member added this way
    // grows the group in every direction, gutter included.
    const store = new FakeDocumentStore()
    await seedCanvas(store, EMPTY)
    const tool = createCanvasEditTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        { op: 'node.add', node: { id: 'g', type: 'group', label: 'Clients' } },
        {
          op: 'node.add',
          within: 'g',
          node: { type: 'text', id: 'web', x: 240, y: 140, width: 160, height: 60, text: 'Web' },
        },
        {
          op: 'node.add',
          within: 'g',
          node: { type: 'text', id: 'cli', x: 40, y: 60, width: 160, height: 60, text: 'CLI' },
        },
        {
          op: 'node.add',
          within: 'g',
          node: {
            type: 'text',
            id: 'mobile',
            x: 440,
            y: 140,
            width: 160,
            height: 60,
            text: 'Mobile',
          },
        },
      ],
    })

    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    const at = (id: string) => {
      const n = canvas.nodes.find((node) => node.id === id) as SpatialNode
      return [n.x, n.y, n.width, n.height]
    }
    expect(at('web')).toEqual([240, 140, 160, 60])
    expect(at('cli')).toEqual([40, 60, 160, 60])
    expect(at('mobile')).toEqual([440, 140, 160, 60])
    expect(at('g')).toEqual([
      40 - PLACEMENT_GUTTER_PX,
      60 - PLACEMENT_GUTTER_PX,
      560 + 2 * PLACEMENT_GUTTER_PX,
      140 + 2 * PLACEMENT_GUTTER_PX,
    ])
  })

  test('another group this batch placed at the cursor, still empty, is not a wall — it will follow its own members', async () => {
    // The lane added three groups with no geometry first, then the
    // members: the cursor put the groups side by side, and the first
    // group's box around its members reached the second, empty one.
    const store = new FakeDocumentStore()
    await seedCanvas(store, EMPTY)
    const tool = createCanvasEditTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        { op: 'node.add', node: { id: 'clients', type: 'group', label: 'Clients' } },
        { op: 'node.add', node: { id: 'services', type: 'group', label: 'Services' } },
        {
          op: 'node.add',
          within: 'clients',
          node: { type: 'text', id: 'cli', x: 100, y: 100, width: 160, height: 60, text: 'CLI' },
        },
        {
          op: 'node.add',
          within: 'clients',
          node: {
            type: 'text',
            id: 'mobile',
            x: 540,
            y: 100,
            width: 160,
            height: 60,
            text: 'Mobile',
          },
        },
        {
          op: 'node.add',
          within: 'services',
          node: { type: 'text', id: 'auth', x: 100, y: 320, width: 160, height: 60, text: 'Auth' },
        },
      ],
    })

    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    const at = (id: string) => {
      const n = canvas.nodes.find((node) => node.id === id) as SpatialNode
      return [n.x, n.y, n.width, n.height]
    }
    expect(at('clients')).toEqual([60, 60, 680, 140])
    expect(at('services')).toEqual([60, 280, 240, 140])
  })

  test('a member added within a cursor-placed group refuses to swallow a bystander, naming it', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [
        textNode({ id: 'between', x: 240, y: 140, width: 160, height: 60, text: 'not mine' }),
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
          { op: 'node.add', node: { id: 'g', type: 'group', label: 'Pair' } },
          {
            op: 'node.add',
            within: 'g',
            node: { type: 'text', id: 'a', x: 40, y: 140, width: 160, height: 60, text: 'A' },
          },
          {
            op: 'node.add',
            within: 'g',
            node: { type: 'text', id: 'c', x: 440, y: 140, width: 160, height: 60, text: 'C' },
          },
        ],
      }),
    ).rejects.toThrow(/"between"/)
  })

  test('within: null on node.add reads as no group', async () => {
    // Models write null to say "not in a group"; refusing it costs the
    // whole call, and the second call is the same batch without the null.
    const store = new FakeDocumentStore()
    await seedCanvas(store, EMPTY)
    const tool = createCanvasEditTool(makeDeps(store))

    const result = await tool.execute(
      canvasEditInputSchema.parse({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [
          {
            op: 'node.add',
            node: { type: 'text', id: 'a', x: 0, y: 0, width: 100, height: 40, text: 'A' },
          },
          { op: 'node.add', within: null, node: { id: 'g', type: 'group', label: 'Later' } },
        ],
      }),
    )
    expect(result.applied).toBe(2)
  })

  test('a group placed around members that sit in a frame nests inside it', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [
        groupNode({ id: 'outer', x: 0, y: 0, width: 1000, height: 400, label: 'Outer' }),
        textNode({ id: 'a', x: 100, y: 100, width: 200, height: 80, text: 'A' }),
        textNode({ id: 'b', x: 400, y: 100, width: 200, height: 80, text: 'B' }),
      ],
      edges: [],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        { op: 'node.add', node: { id: 'inner', type: 'group', label: 'Inner' } },
        { op: 'region.set', within: 'inner', nodes: ['a', 'b'] },
      ],
    })

    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    const inner = canvas.nodes.find((node) => node.id === 'inner') as SpatialNode
    expect([inner.x, inner.y, inner.width, inner.height]).toEqual([60, 60, 580, 160])
  })
})
