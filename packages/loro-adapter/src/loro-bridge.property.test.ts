import type { CanvasLine, LineEnd } from '@kamiazya/whiteboard-model'
import {
  extensionFacetsArbitrary,
  spatialCanvasArbitrary,
  textNode,
} from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc, UndoManager } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { readFacets, writeFacets } from './document-envelope.js'
import {
  deleteSpatialEdge,
  deleteSpatialNode,
  readSpatialCanvas,
  withSpatialBatch,
  writeSpatialCanvas,
  writeSpatialNode,
} from './loro-bridge.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

// A CEILING sized on a measurement, not a delay — and it records a cost this
// branch ADDED rather than one it found.
//
// `spatialCanvasArbitrary` now draws up to three LINES beside its five edges
// (ADR-0038 decision 2), so every generated canvas carries more to write, read
// and merge. Measured as three rounds a side of CI's own repeat command
// (`vitest run --repeats=3 --fsModuleCache`), medians over the three repeats:
//
//   two peers, DIFFERENT comment      2461ms -> 3209ms   +30%
//   peer 1 resolves A / peer 2 adds B 3277ms -> 4223ms   +29%
//   one batch = sequential helpers    2250ms -> 3540ms   +57%
//
// Three rounds each side, no overlap between the two sets, so it is the
// generator and not the draw. The worst then sits at 4223ms of vitest's
// 5000ms default ON AN IDLE MACHINE — 84% — so CI's own load is all it takes
// to put a repeat over.
//
// PER REPEAT, not per test: `--repeats=N` gives each repetition its own
// budget, so the numbers above are already what one repeat costs and the
// remaining 16% is the whole margin. Probed, because the arithmetic looks the
// same either way and the first reading here was that the SUM is charged: a
// 3s body under a 5000ms budget passes `--repeats=3` at 12.16s total, which a
// summed budget could not do.
//
// The density is kept rather than trimmed: a free line end is what this split
// exists for, and drawing fewer would leave the arm barely exercised — it is
// also what found the `-0` the JSON Canvas projection was emitting.
// `tool-inputs.fuzz.property.test.ts` carries a ceiling for the same reason.
// The remedy is never a pinned seed.
vi.setConfig({ testTimeout: 60_000 })

// By code unit, never `localeCompare`: a locale may collate two different ids
// as equal (U+1B52 BALINESE DIGIT TWO and "2" compare 0), and a comparator
// that calls unequal ids equal leaves each side in its own input order.
const byCodeUnit = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0

function byId<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort(byCodeUnit)
}

/**
 * `-0` and `0` are the same point, and no serialisation this project crosses
 * can tell them apart — the Loro record normalises one to the other exactly as
 * `JSON.stringify` does. The model accepts `-0` because rejecting it would
 * refuse `Math.round(-0.2)`, which the editor really produces; what is not
 * true is that it survives a save, and the example below says so directly.
 */
const zeroNormalised = <T extends { x?: number; y?: number }>(value: T): T => ({
  ...value,
  ...(value.x !== undefined && { x: value.x + 0 }),
  ...(value.y !== undefined && { y: value.y + 0 }),
})

/**
 * The same normalisation for an EDGE, whose `bends` are points too
 * (ADR-0037 slice 4). It is separate rather than folded into the helper above
 * because an edge has no `x`/`y` of its own — what it has is a list of them,
 * and the property found the gap the day bends arrived.
 */
const bendsNormalised = <T extends { bends?: readonly { x: number; y: number }[] }>(edge: T): T =>
  edge.bends === undefined ? edge : { ...edge, bends: edge.bends.map(zeroNormalised) }

/**
 * And a third home for the same fact: a FREE endpoint carries its coordinates
 * under `point`, which neither helper above reaches — an endpoint has no
 * `x`/`y` of its own and is not a bend. Each of the three was found by this
 * property on the day its field arrived, which is the argument for keeping
 * the property rather than only the three examples beside it.
 */
const endNormalised = (end: LineEnd): LineEnd =>
  end.kind === 'point' ? { ...end, point: zeroNormalised(end.point) } : end

// Only a LINE's ends can hold a coordinate since ADR-0038 decision 2, so this
// is the only element shape that needs it. An edge's ends name a node.
const linePointsNormalised = (line: CanvasLine): CanvasLine => ({
  ...line,
  from: endNormalised(line.from),
  to: endNormalised(line.to),
})

describe('loro-bridge', () => {
  // The counterexample that found the comparator above, pinned: two ids a
  // locale collates as equal still round-trip as two distinct nodes.
  it('round-trips nodes whose ids a locale collates as equal', () => {
    const node = { x: 0, y: 0, width: 0, height: 0 }
    const canvas = {
      nodes: [
        { ...node, id: '\u1b52' },
        { ...node, id: '2' },
      ],
      edges: [],
    }
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, canvas as never)
    expect(byId(readSpatialCanvas(doc).nodes)).toEqual(byId(canvas.nodes))
  })
})

describe('loro-bridge properties', () => {
  fcTest.prop([spatialCanvasArbitrary], withDefaults())(
    'readSpatialCanvas(writeSpatialCanvas(doc, canvas)) deep-equals canvas up to node/edge order',
    (canvas) => {
      // LoroMap.keys() iteration order is not insertion order — the bridge
      // never promises to preserve node/edge array order, only membership
      // and content (see loro-bridge.test.ts's multi-node cases, which
      // already compare sorted id sets rather than raw array equality).
      const doc = new LoroDoc()
      writeSpatialCanvas(doc, canvas)
      const result = readSpatialCanvas(doc)
      expect(byId(result.nodes)).toEqual(byId(canvas.nodes).map(zeroNormalised))
      expect(byId(result.edges)).toEqual(byId(canvas.edges).map(bendsNormalised))
      // Ink travels its own plane (ADR-0038 decision 2), so it needs its own
      // half of this equality — without it the whole collection could stop
      // being written and the property would stay green.
      expect(byId(result.lines ?? [])).toEqual(
        byId(canvas.lines ?? [])
          .map(bendsNormalised)
          .map(linePointsNormalised),
      )
      // The envelope too — routing preferences and the canvas's facets —
      // because this bridge is the path the app saves through, and a JSON
      // round-trip is no evidence a field persists here.
      expect(result.facets).toEqual(canvas.facets)
      // The board's tags share the envelope and would share its silence: a
      // node's tags fail the node equality above, a board's fail nothing else.
      expect(result.tags).toEqual(canvas.tags)
    },
  )

  it('stores a negative-zero coordinate as zero, because the record cannot carry one', () => {
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, {
      nodes: [textNode({ id: 'n1', text: '', x: -0, y: 1.5, width: 0, height: 0 })],
      edges: [],
    })
    const read = readSpatialCanvas(doc)
    expect(Object.is(read.nodes[0]?.x, 0)).toBe(true)
    // The sub-pixel coordinate beside it DOES survive: what the record cannot
    // carry is the sign of a zero, not the fraction (ADR-0037 slice 4).
    expect(read.nodes[0]?.y).toBe(1.5)
  })

  it('normalises a negative zero in an edge BEND the same way', () => {
    // Reachable rather than theoretical: the bend drag rounds before it
    // writes, and `Math.round(-0.2)` is `-0`. The property found this the day
    // bends became a field; the node case above had been pinned for longer,
    // which is exactly why the edge case needed its own.
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, {
      nodes: [
        textNode({ id: 'a', text: '', x: 0, y: 0, width: 1, height: 1 }),
        textNode({ id: 'b', text: '', x: 9, y: 9, width: 1, height: 1 }),
      ],
      edges: [
        {
          id: 'e',
          from: { node: 'a' },
          to: { node: 'b' },
          bends: [{ x: -0, y: 2.5 }],
        },
      ],
    })
    const bend = readSpatialCanvas(doc).edges[0]?.bends?.[0]
    expect(Object.is(bend?.x, 0)).toBe(true)
    expect(bend?.y).toBe(2.5)
  })

  it('normalises a negative zero in a free LINE end the same way', () => {
    // The third of the three, and the one with the shortest path from a
    // gesture: releasing a connect drag in empty space writes the pointer's
    // rounded position straight into the end. It is a LINE since ADR-0038
    // decision 2 — an edge with a point end was ink wearing a relation's shape.
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, {
      nodes: [textNode({ id: 'a', text: '', x: 0, y: 0, width: 1, height: 1 })],
      edges: [],
      lines: [
        {
          id: 'l',
          from: { kind: 'node' as const, node: 'a' },
          to: { kind: 'point' as const, point: { x: -0, y: 2.5 } },
        },
      ],
    })
    const to = readSpatialCanvas(doc).lines?.[0]?.to
    expect(to?.kind).toBe('point')
    expect(Object.is(to?.kind === 'point' ? to.point.x : undefined, 0)).toBe(true)
    expect(to?.kind === 'point' ? to.point.y : undefined).toBe(2.5)
  })

  fcTest.prop([spatialCanvasArbitrary], withDefaults())(
    'writeSpatialCanvas is total: never throws on a valid SpatialCanvas',
    (canvas) => {
      const doc = new LoroDoc()
      expect(() => writeSpatialCanvas(doc, canvas)).not.toThrow()
    },
  )

  fcTest.prop([extensionFacetsArbitrary], withDefaults())(
    'readFacets(writeFacets(doc, facets)) deep-equals facets (up to -0 normalization)',
    (facets) => {
      const doc = new LoroDoc()
      writeFacets(doc, facets)
      const result = readFacets(doc)
      // Loro normalizes -0 to 0 during storage; JSON.parse(JSON.stringify())
      // applies the same normalization so we compare against that.
      expect(result).toEqual(JSON.parse(JSON.stringify(facets)))
    },
  )
})

// withSpatialBatch equivalence (editor-completeness slice 1): for ANY
// command list drawn from the writer's operations, one batch produces
// the same readSpatialCanvas state as the sequential committing helpers,
// and (when anything was written) exactly one undo step.
type BatchOp =
  | { readonly kind: 'writeNode'; readonly index: number }
  | { readonly kind: 'deleteNode'; readonly index: number }
  | { readonly kind: 'deleteEdge'; readonly index: number }

describe('withSpatialBatch equivalence property', () => {
  fcTest.prop(
    [
      spatialCanvasArbitrary,
      fc.array(
        fc.record({
          kind: fc.constantFrom<'writeNode' | 'deleteNode' | 'deleteEdge'>(
            'writeNode',
            'deleteNode',
            'deleteEdge',
          ),
          index: fc.nat({ max: 7 }),
        }),
        { maxLength: 6 },
      ),
    ],
    withDefaults(),
  )(
    'one batch ≡ sequential helpers on state, and at most one undo step',
    async (canvas, opSpecs) => {
      const ops: BatchOp[] = opSpecs
      const apply = {
        writeNode: (index: number) => canvas.nodes[index % Math.max(1, canvas.nodes.length)],
        deleteNode: (index: number) => canvas.nodes[index % Math.max(1, canvas.nodes.length)]?.id,
        deleteEdge: (index: number) => canvas.edges[index % Math.max(1, canvas.edges.length)]?.id,
      }

      const sequential = new LoroDoc()
      writeSpatialCanvas(sequential, canvas)
      const batched = new LoroDoc()
      batched.import(sequential.export({ mode: 'snapshot' }))

      for (const op of ops) {
        if (op.kind === 'writeNode') {
          const node = apply.writeNode(op.index)
          if (node !== undefined) writeSpatialNode(sequential, { ...node, x: node.x + 1 })
        } else if (op.kind === 'deleteNode') {
          const id = apply.deleteNode(op.index)
          if (id !== undefined) deleteSpatialNode(sequential, id)
        } else {
          const id = apply.deleteEdge(op.index)
          if (id !== undefined) deleteSpatialEdge(sequential, id)
        }
      }

      const undo = new UndoManager(batched, { mergeInterval: 0 })
      withSpatialBatch(batched, (writer) => {
        for (const op of ops) {
          if (op.kind === 'writeNode') {
            const node = apply.writeNode(op.index)
            if (node !== undefined) writer.writeNode({ ...node, x: node.x + 1 })
          } else if (op.kind === 'deleteNode') {
            const id = apply.deleteNode(op.index)
            if (id !== undefined) writer.deleteNode(id)
          } else {
            const id = apply.deleteEdge(op.index)
            if (id !== undefined) writer.deleteEdge(id)
          }
        }
      })

      const stateOf = (doc: LoroDoc) => {
        const value = readSpatialCanvas(doc)
        return {
          nodes: [...value.nodes].sort(byCodeUnit),
          edges: [...value.edges].sort(byCodeUnit),
        }
      }
      expect(stateOf(batched)).toEqual(stateOf(sequential))
      if (undo.canUndo()) {
        undo.undo()
        expect(undo.canUndo()).toBe(false)
      }
    },
  )
})
