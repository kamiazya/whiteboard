// `node.add` into a group: placement, containment and the group growing to fit.

import type { SpatialNode } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, test } from 'vitest'
import { loadDocument } from '../document-io.js'
import { FakeDocumentStore } from '../test-utils/fake-document-store.js'
import { DOCUMENT_ID, makeDeps, seedCanvas, WORKSPACE_ID } from './_test-canvas-edit.js'
import { createCanvasEditTool } from './canvas-edit.js'

describe('wb_canvas_edit — node.add within a group', () => {
  const GROUP = groupNode({ id: 'g', x: 0, y: 0, width: 500, height: 500, label: 'Phase 1' })

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
        textNode({ id: 'cli', x: 40, y: 700, width: 200, height: 80, text: 'CLI' }),
        textNode({ id: 'web', x: 300, y: 700, width: 200, height: 80, text: 'Web app' }),
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
    // It fit in the room the group had, but flush with the bottom edge —
    // the lane's board read that as a cramped member — so the group grows
    // by the gutter it keeps for what it places.
    expect(mobile.y).toBe(820)
    expect(group).toMatchObject({ width: 700, height: 340 })
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
            type: 'text',
            id: 'mobile',
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
              type: 'text',
              id: 'early',
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

  test("a node given a position exactly on the group's top-left is inside it, not refused", async () => {
    // A child at its group's corner is the most natural placement there is;
    // containment is inclusive of the edge.
    const store = new FakeDocumentStore()
    await seedCanvas(store, { nodes: [{ ...GROUP, x: 100, y: 100 }], edges: [] })
    const tool = createCanvasEditTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        {
          op: 'node.add',
          node: {
            id: 'corner',
            type: 'text',
            text: 'corner',
            x: 100,
            y: 100,
            width: 100,
            height: 60,
          },
          within: 'g',
        },
      ],
    })

    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.nodes.find((node) => node.id === 'corner')).toMatchObject({ x: 100, y: 100 })
    expect(canvas.nodes.find((node) => node.id === 'g')).toMatchObject({ x: 100, y: 100 })
  })

  test('a group positioned earlier in the batch refuses a member before its top-left rather than regrowing', async () => {
    // Only a group the CURSOR placed has a box derived from its members; one
    // the caller positioned has a top-left somebody chose, so growing it up
    // and left over its neighbours would override that choice.
    const store = new FakeDocumentStore()
    await seedCanvas(store, { nodes: [], edges: [] })
    const tool = createCanvasEditTool(makeDeps(store))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [
          {
            op: 'node.add',
            node: { id: 'g2', type: 'group', label: 'G', x: 100, y: 100, width: 300, height: 300 },
          },
          {
            op: 'node.add',
            node: { id: 'm', type: 'text', text: 'm', x: 50, y: 50, width: 40, height: 40 },
            within: 'g2',
          },
        ],
      }),
    ).rejects.toMatchObject({
      name: 'CanvasEditError',
      opIndex: 1,
      message: expect.stringMatching(/left edge 50 is before the group's 100/),
    })
    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.nodes).toEqual([])
  })

  test('a node given an x but no y is placed inside the group, not at half a position', async () => {
    // Partial geometry is treated as none: guessing the missing half would put
    // the node somewhere the caller did not ask for either.
    const store = new FakeDocumentStore()
    await seedCanvas(store, { nodes: [{ ...GROUP, x: 100, y: 100 }], edges: [] })
    const tool = createCanvasEditTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        { op: 'node.add', node: { id: 'half', type: 'text', text: 'half', x: 5 }, within: 'g' },
      ],
    })

    // Geometry is reported for what the server placed, never for a position
    // the caller chose — so its presence is the evidence of placement.
    const placed = result.geometry.find((entry) => entry.id === 'half')
    expect(placed).toBeDefined()
    expect(placed?.x).toBeGreaterThanOrEqual(100)
    expect(placed?.y).toBeGreaterThanOrEqual(100)
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
        // 260 WIDE ON PURPOSE, and the second half of this test is what
        // needs it: a node added with no geometry takes the board's
        // prevailing box width, and this neighbour is the only box on the
        // board, so it IS that width. At its original 80 the placed box
        // fitted inside the group, nothing grew, and the refusal this test
        // exists for never fired — a fixture that had stopped reaching its
        // own case while still reading as a passing test.
        textNode({ id: 'neighbour', x: 220, y: 20, width: 260, height: 40, text: 'next door' }),
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
            node: { type: 'text', id: 'wide', x: 150, y: 20, width: 100, height: 40, text: 'wide' },
            within: 'g',
          },
        ],
      }),
    ).rejects.toMatchObject({
      name: 'CanvasEditError',
      opIndex: 0,
      message: expect.stringMatching(/"neighbour"/),
    })
    // The placed path hits the same wall: a box sized from the board does
    // not fit a 200x100 group, so it grows right, and the neighbour sits
    // there.
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
      nodes: [textNode({ id: 'plain', x: 0, y: 0, width: 10, height: 10, text: 'plain' })],
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

  for (const [axis, at] of [
    ['y', { x: 0, y: 1e20 }],
    ['x', { x: 1e20, y: 0 }],
  ] as const) {
    test(`refuses to place inside a group at ${axis} = 1e20, naming the way out`, async () => {
      // Past about 2^60 adding a height and the gutter no longer moves a
      // coordinate, so rows cannot be stacked and the group cannot grow to
      // hold them: what the caller can change is the node's x/y or the group.
      const store = new FakeDocumentStore()
      await seedCanvas(store, { nodes: [], edges: [] })
      const tool = createCanvasEditTool(makeDeps(store))

      const attempt = tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [
          { op: 'node.add', node: { id: 'far', type: 'group', ...at, width: 400, height: 400 } },
          { op: 'node.add', node: { id: 'a', type: 'text', text: 'A' }, within: 'far' },
        ],
      })

      await expect(attempt).rejects.toMatchObject({ name: 'CanvasEditError', opIndex: 1 })
      await expect(attempt).rejects.toThrow(/explicit x\/y.*move the group/)
    })
  }
})
