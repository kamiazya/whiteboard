// Adopting a change (ADR-0029 decision 4) and telling whether it still fits
// the document (decision 5). Both are pure and both belong beside the schema:
// the web editor adopts, and a later MCP verb will adopt the same way, and a
// second implementation of "what does this change mean" would be free to
// disagree with the first.

import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { withNodeText } from './node-content.js'
import type { SpatialProposedChange } from './proposal.js'
import { applyCanvasChange, canvasChangeConflicts } from './proposal-apply.js'
import type { CanvasEdge, CanvasLine, SpatialCanvas } from './spatial.js'

const NODE_A = textNode({ id: 'a', x: 0, y: 0, width: 100, height: 40, text: 'A' })
const NODE_B = textNode({ id: 'b', x: 200, y: 0, width: 100, height: 40, text: 'B' })
const EDGE = {
  id: 'e',
  from: { node: 'a' },
  to: { node: 'b' },
} as const
const BOARD: SpatialCanvas = { nodes: [NODE_A, NODE_B], edges: [EDGE] }

const PATCH_A: SpatialProposedChange = {
  id: 'node:a',
  status: 'open',
  op: 'node.patch',
  nodeId: 'a',
  patch: { x: 400 },
  assumed: { x: 0 },
}

describe('applyCanvasChange', () => {
  it('adds a proposed node where it was drawn', () => {
    const next = applyCanvasChange(BOARD, {
      id: 'node:c',
      status: 'open',
      op: 'node.add',
      node: textNode({ id: 'c', x: 400, y: 400, width: 80, height: 30, text: 'C' }),
    })
    expect(next.nodes.map((node) => node.id)).toEqual(['a', 'b', 'c'])
  })

  it('merges a patch into the node it names, leaving the rest alone', () => {
    const next = applyCanvasChange(BOARD, PATCH_A)
    expect(next.nodes.find((node) => node.id === 'a')).toEqual({ ...NODE_A, x: 400 })
    expect(next.nodes.find((node) => node.id === 'b')).toEqual(NODE_B)
    expect(next.edges).toEqual([EDGE])
  })

  it('removes the node it names and the edges that would dangle', () => {
    const next = applyCanvasChange(BOARD, {
      id: 'node:a',
      status: 'open',
      op: 'node.remove',
      nodeId: 'a',
      assumed: NODE_A,
    })
    expect(next.nodes.map((node) => node.id)).toEqual(['b'])
    // An edge to a node that is gone is not a canvas anyone can render, and
    // the schema refuses it — so adopting the removal takes it too.
    expect(next.edges).toEqual([])
  })

  it('adds, patches and removes an edge', () => {
    const added = applyCanvasChange(
      { nodes: [NODE_A, NODE_B], edges: [] },
      { id: 'edge:e', status: 'open', op: 'edge.add', edge: EDGE },
    )
    expect(added.edges).toEqual([EDGE])
    const patched = applyCanvasChange(BOARD, {
      id: 'edge:e',
      status: 'open',
      op: 'edge.patch',
      edgeId: 'e',
      patch: { label: 'to' },
      assumed: {},
    })
    expect(patched.edges).toEqual([{ ...EDGE, label: 'to' }])
    const removed = applyCanvasChange(BOARD, {
      id: 'edge:e',
      status: 'open',
      op: 'edge.remove',
      edgeId: 'e',
      assumed: EDGE,
    })
    expect(removed.edges).toEqual([])
  })

  // Adoption must be idempotent: two people pressing Adopt on the same
  // change, or one pressing it twice, is an ordinary race.
  it('is idempotent', () => {
    const once = applyCanvasChange(BOARD, PATCH_A)
    expect(applyCanvasChange(once, PATCH_A)).toEqual(once)
  })

  it.each<SpatialProposedChange>([
    {
      id: 'add:n',
      status: 'open',
      op: 'node.add',
      node: textNode({ id: 'n', x: 0, y: 90, width: 100, height: 40, text: 'N' }),
    },
    {
      id: 'add:e',
      status: 'open',
      op: 'edge.add',
      edge: { id: 'e2', from: { node: 'a' }, to: { node: 'b' } },
    },
    {
      id: 'add:l',
      status: 'open',
      op: 'line.add',
      line: {
        id: 'l',
        from: { kind: 'node', node: 'a' },
        to: { kind: 'point', point: { x: 5, y: 80 } },
      },
    },
  ])('adopts $op once however many times it is pressed', (change) => {
    const once = applyCanvasChange(BOARD, change)
    expect(applyCanvasChange(once, change)).toEqual(once)
  })

  it('leaves the canvas alone when the change names nothing that is there', () => {
    const gone: SpatialCanvas = { nodes: [NODE_B], edges: [] }
    expect(applyCanvasChange(gone, PATCH_A)).toEqual(gone)
  })
})

describe('canvasChangeConflicts', () => {
  it('sees no conflict while the anchor still holds what was assumed', () => {
    expect(canvasChangeConflicts(PATCH_A, BOARD)).toBe(false)
  })

  // Decision 5's whole point: an edit ELSEWHERE is not a collision. The
  // proposal follows the document rather than being stranded by it.
  it('sees no conflict when somebody edited a field the change does not touch', () => {
    const moved = { ...BOARD, nodes: [{ ...NODE_A, y: 999 }, NODE_B] }
    expect(canvasChangeConflicts(PATCH_A, moved)).toBe(false)
  })

  it('sees a conflict when the anchor no longer holds the assumed value', () => {
    const moved = { ...BOARD, nodes: [{ ...NODE_A, x: 50 }, NODE_B] }
    expect(canvasChangeConflicts(PATCH_A, moved)).toBe(true)
  })

  // A prior that OMITS a field claims the anchor held nothing there, so
  // something appearing is as much a collision as something changing.
  it('sees a conflict when a field the prior said was absent now has a value', () => {
    const coloured: SpatialProposedChange = {
      id: 'node:a',
      status: 'open',
      op: 'node.patch',
      nodeId: 'a',
      patch: { color: '3' },
      assumed: {},
    }
    expect(canvasChangeConflicts(coloured, BOARD)).toBe(false)
    expect(
      canvasChangeConflicts(coloured, { ...BOARD, nodes: [{ ...NODE_A, color: '5' }, NODE_B] }),
    ).toBe(true)
  })

  it('sees a conflict when the element the change is about is gone', () => {
    expect(canvasChangeConflicts(PATCH_A, { nodes: [NODE_B], edges: [] })).toBe(true)
  })

  // An add has no prior, so the only collision it can have is somebody
  // taking its id first.
  it('sees a conflict when an addition would collide with an id already taken', () => {
    const add: SpatialProposedChange = {
      id: 'node:c',
      status: 'open',
      op: 'node.add',
      node: textNode({ id: 'c', x: 0, y: 0, width: 10, height: 10, text: 'C' }),
    }
    expect(canvasChangeConflicts(add, BOARD)).toBe(false)
    expect(
      canvasChangeConflicts(add, { ...BOARD, nodes: [...BOARD.nodes, { ...NODE_A, id: 'c' }] }),
    ).toBe(true)
  })

  it('sees a conflict when a removal would delete something that changed', () => {
    const remove: SpatialProposedChange = {
      id: 'node:a',
      status: 'open',
      op: 'node.remove',
      nodeId: 'a',
      assumed: NODE_A,
    }
    expect(canvasChangeConflicts(remove, BOARD)).toBe(false)
    expect(
      canvasChangeConflicts(remove, { ...BOARD, nodes: [withNodeText(NODE_A, 'edited'), NODE_B] }),
    ).toBe(true)
  })
})

describe('ink lines and edges in a proposal', () => {
  const pointAt = (x: number) => ({ kind: 'point' as const, point: { x, y: 0 } })
  const inkLine = (id: string, over: Partial<CanvasLine> = {}): CanvasLine => ({
    id,
    from: pointAt(0),
    to: pointAt(10),
    ...over,
  })
  const link = (id: string, over: Partial<CanvasEdge> = {}): CanvasEdge => ({
    id,
    from: { node: 'a' },
    to: { node: 'b' },
    ...over,
  })
  const linesOf = (canvas: SpatialCanvas) => canvas.lines ?? []

  it('patches the named line only', () => {
    const c: SpatialCanvas = { ...BOARD, lines: [inkLine('l1'), inkLine('l2')] }
    const out = applyCanvasChange(c, {
      id: 'line:l1',
      status: 'open',
      op: 'line.patch',
      lineId: 'l1',
      patch: { color: '1' },
      assumed: {},
    })
    expect(linesOf(out).find((l) => l.id === 'l1')?.color).toBe('1')
    expect(linesOf(out).find((l) => l.id === 'l2')?.color).toBeUndefined()
    expect(linesOf(out)).toHaveLength(2)
  })

  it('leaves the canvas as it was when the patched line is gone', () => {
    const c: SpatialCanvas = { ...BOARD, lines: [inkLine('l1')] }
    expect(
      applyCanvasChange(c, {
        id: 'line:zz',
        status: 'open',
        op: 'line.patch',
        lineId: 'zz',
        patch: { color: '1' },
        assumed: {},
      }),
    ).toEqual(c)
  })

  it('removes a line and leaves `lines` absent when the last one goes', () => {
    const remove = (lineId: string, assumed: CanvasLine): SpatialProposedChange => ({
      id: `line:${lineId}`,
      status: 'open',
      op: 'line.remove',
      lineId,
      assumed,
    })
    const two: SpatialCanvas = { ...BOARD, lines: [inkLine('l1'), inkLine('l2')] }
    expect(linesOf(applyCanvasChange(two, remove('l1', inkLine('l1'))))).toHaveLength(1)
    const last = applyCanvasChange(
      { ...BOARD, lines: [inkLine('l1')] },
      remove('l1', inkLine('l1')),
    )
    expect('lines' in last).toBe(false)
  })

  it('adds an edge only when its id is free, and removes an edge by id', () => {
    const add = (id: string): SpatialProposedChange => ({
      id: `edge:${id}`,
      status: 'open',
      op: 'edge.add',
      edge: link(id),
    })
    expect(applyCanvasChange(BOARD, add('e')).edges).toHaveLength(1)
    expect(applyCanvasChange(BOARD, add('e2')).edges.map((e) => e.id)).toEqual(['e', 'e2'])
    const removed = applyCanvasChange(BOARD, {
      id: 'edge:e',
      status: 'open',
      op: 'edge.remove',
      edgeId: 'e',
      assumed: link('e'),
    })
    expect(removed.edges).toEqual([])
  })

  it('flags an addition whose id is taken, for edges and lines alike', () => {
    const c: SpatialCanvas = { ...BOARD, edges: [link('e1')], lines: [inkLine('l1')] }
    const add = (op: 'edge.add' | 'line.add', id: string): SpatialProposedChange =>
      op === 'edge.add'
        ? { id: `x:${id}`, status: 'open', op, edge: link(id) }
        : { id: `x:${id}`, status: 'open', op, line: inkLine(id) }
    expect(canvasChangeConflicts(add('edge.add', 'e1'), c)).toBe(true)
    expect(canvasChangeConflicts(add('edge.add', 'e2'), c)).toBe(false)
    expect(canvasChangeConflicts(add('line.add', 'l1'), c)).toBe(true)
    expect(canvasChangeConflicts(add('line.add', 'l2'), c)).toBe(false)
  })

  it('flags a removal whose element changed or is gone, for edges and lines alike', () => {
    const c: SpatialCanvas = { ...BOARD, edges: [link('e1')], lines: [inkLine('l1')] }
    const removeEdge = (edgeId: string, assumed: CanvasEdge): SpatialProposedChange => ({
      id: `edge:${edgeId}`,
      status: 'open',
      op: 'edge.remove',
      edgeId,
      assumed,
    })
    const removeLine = (lineId: string, assumed: CanvasLine): SpatialProposedChange => ({
      id: `line:${lineId}`,
      status: 'open',
      op: 'line.remove',
      lineId,
      assumed,
    })
    expect(canvasChangeConflicts(removeEdge('e1', link('e1')), c)).toBe(false)
    expect(canvasChangeConflicts(removeEdge('e1', link('e1', { label: 'changed' })), c)).toBe(true)
    expect(canvasChangeConflicts(removeEdge('gone', link('gone')), c)).toBe(true)
    expect(canvasChangeConflicts(removeLine('l1', inkLine('l1')), c)).toBe(false)
    expect(canvasChangeConflicts(removeLine('l1', inkLine('l1', { color: '3' })), c)).toBe(true)
    expect(canvasChangeConflicts(removeLine('gone', inkLine('gone')), c)).toBe(true)
  })

  it('flags a patch of a line that is gone', () => {
    expect(
      canvasChangeConflicts(
        {
          id: 'line:gone',
          status: 'open',
          op: 'line.patch',
          lineId: 'gone',
          patch: {},
          assumed: {},
        },
        { ...BOARD, lines: [inkLine('l1')] },
      ),
    ).toBe(true)
  })
})
