/**
 * What a selector-wide `node.patch` costs the session, COUNTED rather than
 * timed so the number is the same on any machine and under any load.
 *
 * The count is reads of a node's `id`: resolving a node by id and writing a
 * patched one back both walk the board by id, so a proxy over each node the
 * board was loaded with sees that work without asking the session for a
 * number. A patch that re-walks the whole board once per patched node is
 * quadratic in the board, and one batch may hold many such ops.
 */
import type { FacetRegistry } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialNode } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { DOCUMENT_ID, WORKSPACE_ID } from './_test-canvas-edit.js'
import { applyCanvasOp } from './canvas-edit-handlers.js'
import { canvasEditInputSchema } from './canvas-edit-ops.js'
import { CanvasEditSession } from './canvas-edit-session.js'

const BOARD = 2000
/**
 * A few walks of the board for the whole op, never one per patched node.
 * Measured at five id reads per node (selecting, indexing — which reads an
 * id twice — copying, writing back); patching each node by re-mapping the
 * board read these ids 6,007,000 times.
 */
const ID_READ_CEILING = 6 * BOARD

function countingBoard(count: number): { nodes: SpatialNode[]; idReads: () => number } {
  let idReads = 0
  const nodes = Array.from({ length: count }, (_, i) => {
    const node = textNode({ id: `n${i}`, x: i * 10, y: 0, width: 100, height: 40, text: `n${i}` })
    return new Proxy(node, {
      get(target, key, receiver) {
        if (key === 'id') idReads += 1
        return Reflect.get(target, key, receiver)
      },
    })
  })
  return { nodes, idReads: () => idReads }
}

describe('node.patch cost', () => {
  it('patching every node walks the board a constant number of times', () => {
    const board = countingBoard(BOARD)
    const session = new CanvasEditSession(
      { nodes: board.nodes, edges: [] },
      new LoroDoc(),
      undefined,
    )
    const { ops } = canvasEditInputSchema.parse({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [{ op: 'node.patch', all: true, patch: { x: 7 } }],
    })
    // node.patch reads the registry only for a stencil, which this op names none of.
    applyCanvasOp({ s: session, facetRegistry: {} as FacetRegistry }, ops[0] as never, 0)
    expect(session.nodes.every((node) => node.x === 7)).toBe(true)
    expect(board.idReads()).toBeLessThanOrEqual(ID_READ_CEILING)
  })
})
