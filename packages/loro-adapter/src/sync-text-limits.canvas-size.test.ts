import { CANVAS_MAX_EDGES, CANVAS_MAX_NODES, type SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { DocumentContainers } from './containers.js'
import {
  deleteSpatialEdge,
  deleteSpatialNode,
  writeSpatialCanvas,
  writeSpatialEdge,
  writeSpatialNode,
} from './loro-bridge.js'
import {
  importWithinTextLimits,
  judgeStateWithinTextLimits,
  SYNC_TEXT_BREACH_CODES,
  syncTextLimitJudge,
} from './sync-text-limits.js'
import { createWorkspaceDocumentAtPath, documentContainers } from './workspace-tree.js'

const DOC_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'

const box = (i: number | string) =>
  textNode({ id: `n${i}`, x: 0, y: 0, width: 100, height: 40, text: `n${i}` })
const edge = (i: number | string) => ({ id: `e${i}`, from: { node: 'n0' }, to: { node: 'n1' } })

function canvasOf(nodes: number, edges: number): SpatialCanvas {
  return {
    nodes: Array.from({ length: nodes }, (_, i) => box(i)),
    edges: Array.from({ length: edges }, (_, i) => edge(i)),
  }
}

/** Where the board lives: inside a workspace record, or at a document's own root. */
const PLACEMENTS = {
  'a workspace record': (doc: LoroDoc): DocumentContainers => {
    createWorkspaceDocumentAtPath(doc, { path: 'board', documentId: DOC_ID, kind: 'spatial' })
    return documentContainers(doc, DOC_ID)
  },
  "a document's own root": (doc: LoroDoc): DocumentContainers => doc,
} as const

type Placement = keyof typeof PLACEMENTS
const reopen = (placement: Placement, doc: LoroDoc): DocumentContainers =>
  placement === 'a workspace record' ? documentContainers(doc, DOC_ID) : doc

function stored(placement: Placement, canvas: SpatialCanvas): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(PLACEMENTS[placement](doc), canvas)
  doc.commit()
  return doc
}

function updateFrom(
  placement: Placement,
  base: LoroDoc,
  edit: (board: DocumentContainers) => void,
): Uint8Array {
  const client = base.fork()
  const from = client.oplogVersion()
  edit(reopen(placement, client))
  client.commit()
  return client.export({ mode: 'update', from })
}

/** Both keepers' verdicts, which must agree. */
function judged(base: LoroDoc, update: Uint8Array) {
  const imported = importWithinTextLimits(base.fork(), update).breach
  expect(syncTextLimitJudge(base)(update)).toEqual(imported)
  return imported
}

const addNode = (board: DocumentContainers) => writeSpatialNode(board, box('extra'))
const addEdge = (board: DocumentContainers) => writeSpatialEdge(board, edge('extra'))

describe.each(Object.keys(PLACEMENTS) as Placement[])('a board in %s', (placement) => {
  it('refuses an update that adds a node past the per-canvas ceiling', () => {
    const base = stored(placement, canvasOf(CANVAS_MAX_NODES, 0))
    const update = updateFrom(placement, base, addNode)
    expect(judged(base, update)).toEqual({
      shape: 'canvas-size',
      measure: 'nodes',
      count: CANVAS_MAX_NODES + 1,
      container: expect.any(String),
    })
  })

  it('refuses an update that adds an edge past the per-canvas ceiling', () => {
    const base = stored(placement, canvasOf(2, CANVAS_MAX_EDGES))
    expect(judged(base, updateFrom(placement, base, addEdge))).toEqual({
      shape: 'canvas-size',
      measure: 'edges',
      count: CANVAS_MAX_EDGES + 1,
      container: expect.any(String),
    })
  })

  it('takes an update that fills the board to the ceiling exactly', () => {
    const base = stored(placement, canvasOf(CANVAS_MAX_NODES - 1, CANVAS_MAX_EDGES - 1))
    const update = updateFrom(placement, base, (board) => {
      addNode(board)
      addEdge(board)
    })
    expect(judged(base, update)).toBeNull()
  })

  it('still takes an edit that adds nothing to a board already past the ceiling', () => {
    const base = stored(placement, canvasOf(CANVAS_MAX_NODES + 1, CANVAS_MAX_EDGES + 1))
    const update = updateFrom(placement, base, (board) => {
      deleteSpatialNode(board, 'n5')
      addNode(board)
      deleteSpatialEdge(board, 'e5')
      addEdge(board)
      writeSpatialNode(board, { ...box(7), x: 40 })
    })
    expect(judged(base, update)).toBeNull()
  })

  it('refuses growth of a board already past the ceiling', () => {
    const base = stored(placement, canvasOf(CANVAS_MAX_NODES + 1, 0))
    expect(judged(base, updateFrom(placement, base, addNode))).toMatchObject({
      shape: 'canvas-size',
      measure: 'nodes',
      count: CANVAS_MAX_NODES + 2,
    })
  })
})

it('answers the canvas ceiling with its own refusal code', () => {
  expect(SYNC_TEXT_BREACH_CODES['canvas-size']).toBe('too_many_nodes_or_edges')
})

it('judges a short update against the board as the record holds it now, not as the judge last read it', () => {
  const record = stored("a document's own root", canvasOf(10, 0))
  const judge = syncTextLimitJudge(record)
  // Read once while the board is small, so the judge holds a low bound.
  expect(judge(updateFrom("a document's own root", record, addNode))).toBeNull()
  // The record grows to the ceiling by an update the judge never saw.
  const fill = updateFrom("a document's own root", record, (board) => {
    for (let i = 10; i < CANVAS_MAX_NODES; i += 1) writeSpatialNode(board, box(i))
  })
  record.import(fill)
  expect(judge(updateFrom("a document's own root", record, addNode))).toMatchObject({
    shape: 'canvas-size',
    count: CANVAS_MAX_NODES + 1,
  })
})

describe('judgeStateWithinTextLimits', () => {
  it('judges the state a checked-out document shows, not its head', () => {
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, canvasOf(CANVAS_MAX_NODES + 1, 0))
    doc.commit()
    const oversized = doc.frontiers()
    writeSpatialCanvas(doc, canvasOf(1, 0))
    doc.commit()
    expect(judgeStateWithinTextLimits(doc)).toBeNull()
    doc.checkout(oversized)
    expect(judgeStateWithinTextLimits(doc)).toMatchObject({
      shape: 'canvas-size',
      measure: 'nodes',
      count: CANVAS_MAX_NODES + 1,
    })
    // Left as it was: still checked out where the caller put it.
    expect(doc.isDetached()).toBe(true)
    expect(doc.frontiers()).toEqual(oversized)
  })

  it('admits a state at the limit', () => {
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, canvasOf(CANVAS_MAX_NODES, CANVAS_MAX_EDGES))
    doc.commit()
    expect(judgeStateWithinTextLimits(doc)).toBeNull()
  })
})
