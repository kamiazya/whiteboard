import { type EdgeRoutingStyle, edgeSideSchema, type SpatialNode } from '@kamiazya/whiteboard-model'
import type { RoutableElement } from '@kamiazya/whiteboard-scene'
import type { Rect } from '../../layout/edges/edge-geometry.js'
import type { EdgeAnchorOverride, EdgeAnchorPair } from '../../layout/edges/edge-sides.js'
import { createRoutingBudget } from '../../layout/edges/routing-budget.js'
import { fc } from '../fast-check.js'
import { rect } from './edge-arbitraries.js'
import type { encodeRouting } from './routing-wire.js'

/**
 * Canvases, styles, overrides and budget accounts for the side-choice
 * search's Rust differentials (ADR-0054 step 5), and the wire input
 * `edge_assign_anchors` and `edge_route_layout` both read.
 */

export const SIDES = edgeSideSchema.options
const sideIndex = (s: string | undefined) => (s === undefined ? -1 : SIDES.indexOf(s as never))
const STYLES: Record<EdgeRoutingStyle, number> = { straight: 0, orthogonal: 1, curved: 2 }
// Straight mostly: only a straight edge steps round what is in its way.
const style = fc.constantFrom<EdgeRoutingStyle>(
  'straight',
  'straight',
  'straight',
  'orthogonal',
  'curved',
)
const side = fc.constantFrom(...SIDES)

/**
 * Boxes on a jittered grid with edges drawn between them at random, so
 * routes cross and overlap and the search has something to repair.
 */
export const board = (maxBoxes: number, maxEdges: number, minEdges = 1) =>
  fc
    .tuple(
      fc.integer({ min: 2, max: 4 }),
      fc.array(fc.tuple(fc.integer({ min: -30, max: 30 }), fc.integer({ min: -30, max: 30 })), {
        minLength: 3,
        maxLength: maxBoxes,
      }),
    )
    .chain(([columns, jitter]) => {
      const nodes = jitter.map(
        ([dx, dy], i) =>
          ({
            id: `n${i}`,
            type: 'text',
            text: '',
            x: (i % columns) * 180 + dx,
            y: Math.floor(i / columns) * 140 + dy,
            width: 80,
            height: 50,
          }) as SpatialNode,
      )
      const end = fc.record(
        {
          node: fc.constantFrom(...nodes.map((n) => n.id)),
          side: fc.option(side, { freq: 4, nil: undefined }),
        },
        { requiredKeys: ['node'] },
      )
      const edge = fc
        .tuple(fc.integer({ min: 0, max: maxEdges * 2 }), end, end)
        .map(([id, from, to]) => ({ id: `b${id}`, from, to }) as RoutableElement)
      return fc.tuple(
        fc.constant(nodes),
        fc.array(edge, { minLength: minEdges, maxLength: maxEdges }),
      )
    })

const flaggedPoint = (p: { x: number; y: number } | undefined) =>
  p === undefined ? [0, 0, 0] : [1, p.x, p.y]
const flagged = (v: number | undefined) => (v === undefined ? [0, 0] : [1, v])

export function entryValues(id: number, e: EdgeAnchorPair): number[] {
  return [
    id,
    ...flaggedPoint(e.from),
    ...flaggedPoint(e.to),
    ...flagged(e.fromLaneDepth),
    ...flagged(e.toLaneDepth),
    sideIndex(e.fromSide),
    sideIndex(e.toSide),
    e.around === true ? 1 : 0,
  ]
}

/** Overrides for some edges: sides, sometimes stepping round, sometimes pinned. */
const overridesFor = (edges: readonly RoutableElement[]) =>
  fc.option(
    fc.tuple(
      ...edges.map(() =>
        fc.option(
          fc.record({
            fromSide: side,
            toSide: side,
            around: fc.boolean(),
            from: fc.option(
              fc.record({
                x: fc.integer({ min: -50, max: 600 }),
                y: fc.integer({ min: -50, max: 400 }),
              }),
              {
                nil: undefined,
                freq: 3,
              },
            ),
          }),
          { nil: undefined, freq: 2 },
        ),
      ),
    ),
    { nil: undefined, freq: 2 },
  )

/** The trials and pairs accounts: ample mostly, sometimes cut short. */
const accountDraw = (ample: number) =>
  fc.oneof(
    { weight: 3, arbitrary: fc.constant(ample) },
    { weight: 1, arbitrary: fc.integer({ min: 0, max: 400 }) },
    { weight: 1, arbitrary: fc.integer({ min: 0, max: 20_000 }) },
  )

/** How a draw varies what is around the canvas; each defaults to the broad mix. */
export interface Around {
  readonly cut?: fc.Arbitrary<number | undefined>
  readonly style?: fc.Arbitrary<EdgeRoutingStyle>
  /** `false`: no overrides, and both accounts ample. */
  readonly frozen?: boolean
}

export const drawn = (
  canvas: fc.Arbitrary<[SpatialNode[], RoutableElement[]]>,
  around: Around = {},
) =>
  canvas.chain(([nodes, edges]) =>
    fc.record({
      nodes: fc.constant(nodes),
      edges: fc.constant(edges),
      styles: fc.tuple(...edges.map(() => around.style ?? style)),
      overrides: around.frozen === false ? fc.constant(undefined) : overridesFor(edges),
      labels: fc.array(rect, { maxLength: 2 }),
      trials:
        around.frozen === false
          ? fc.constant(createRoutingBudget().trials)
          : accountDraw(createRoutingBudget().trials),
      // A fraction of what the search spends with the account ample, so it
      // runs out partway through, after it has adopted something.
      cut:
        around.cut ??
        fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: undefined, freq: 5 }),
      pairs:
        around.frozen === false
          ? fc.constant(createRoutingBudget().pairs)
          : accountDraw(createRoutingBudget().pairs),
    }),
  )

export type Drawn = typeof drawn extends (...args: never[]) => fc.Arbitrary<infer T> ? T : never

export function overrideMap(d: Drawn): Map<string, EdgeAnchorOverride> | undefined {
  if (d.overrides === undefined) return undefined
  const map = new Map<string, EdgeAnchorOverride>()
  d.edges.forEach((edge, i) => {
    const o = d.overrides?.[i]
    if (o === undefined) return
    map.set(edge.id, {
      fromSide: o.fromSide,
      toSide: o.toSide,
      ...(o.around ? { around: true as const } : {}),
      ...(o.from === undefined ? {} : { from: o.from }),
    })
  })
  return map
}

/** The input `edge_assign_anchors` reads for `d`, with `trials` in the account. */
export function wireInput(
  d: Drawn,
  wire: ReturnType<typeof encodeRouting>,
  overrides: ReadonlyMap<string, EdgeAnchorOverride> | undefined,
  trials: number,
  grid = createRoutingBudget().grid,
): Float64Array {
  const idOf = (id: string) => wire.edgeIds.indexOf(id)
  const labels = d.labels as readonly Rect[]
  const fresh = createRoutingBudget()
  return Float64Array.from([
    ...wire.values,
    ...d.styles.map((s) => STYLES[s as EdgeRoutingStyle]),
    overrides === undefined ? 0 : 1,
    ...(overrides === undefined
      ? []
      : [
          overrides.size,
          ...[...overrides].flatMap(([id, p]) => [
            idOf(id),
            sideIndex(p.fromSide),
            sideIndex(p.toSide),
            p.around === true ? 1 : 0,
            ...flaggedPoint(p.from),
            ...flagged(p.fromLaneDepth),
            ...flaggedPoint(p.to),
            ...flagged(p.toLaneDepth),
          ]),
        ]),
    labels.length,
    ...labels.flatMap((r) => [r.x, r.y, r.w, r.h]),
    grid,
    d.pairs,
    trials,
    fresh.repairs,
  ])
}
