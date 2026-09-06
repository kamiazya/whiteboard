// Adopting a change (ADR-0029 decision 4) and telling whether it still fits
// the document (decision 5). Both are pure and both belong beside the schema:
// the web editor adopts, and a later MCP verb will adopt the same way, and a
// second implementation of "what does this change mean" would be free to
// disagree with the first.
import { describe, expect, it } from 'vitest'
import type { SpatialProposedChange } from './proposal.js'
import { applyCanvasChange, canvasChangeConflicts } from './proposal-apply.js'
import type { SpatialCanvas } from './spatial.js'

const NODE_A = { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 40, text: 'A' } as const
const NODE_B = { id: 'b', type: 'text', x: 200, y: 0, width: 100, height: 40, text: 'B' } as const
const EDGE = { id: 'e', fromNode: 'a', toNode: 'b' } as const
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
      node: { id: 'c', type: 'text', x: 400, y: 400, width: 80, height: 30, text: 'C' },
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
      node: { id: 'c', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'C' },
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
      canvasChangeConflicts(remove, { ...BOARD, nodes: [{ ...NODE_A, text: 'edited' }, NODE_B] }),
    ).toBe(true)
  })
})
