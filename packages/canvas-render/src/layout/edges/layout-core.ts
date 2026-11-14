import type { EdgeRoutingStyle, SpatialNode } from '@kamiazya/whiteboard-model'
import type { ResolvedEdgeNode, RoutableElement } from '@kamiazya/whiteboard-scene'
import type { Rect } from './edge-geometry.js'
import { routeEdge } from './edge-router.js'
import type { EdgeAnchorOverride, EdgeAnchorPair } from './edge-sides.js'
import type { CanvasLayoutCore, CanvasLayoutMismatch } from '../../canvas-core.js'
import type { RoutingBudget } from './routing-budget.js'
import { assignEdgeAnchors } from './spatial-edges.js'

/**
 * ADR-0054's per-function switch: who answers a function the Rust core
 * ports. `ts` runs the TypeScript alone; `differential` runs both, reports
 * any difference and answers with the TypeScript; `rust` answers with the
 * core, the TypeScript still present so rollback is flipping this back.
 */
export type CoreImpl = 'ts' | 'differential' | 'rust'

/** One layout's routes, in input order, and the anchors the side search settled. */
export interface RoutedLayout {
  readonly routes: readonly ResolvedEdgeNode[]
  readonly anchors: ReadonlyMap<string, EdgeAnchorPair>
}

/**
 * The Rust core's one-call routing, as `@kamiazya/whiteboard-core-wasm`'s
 * `Core` answers it. Declared here, structurally, so this package never
 * imports the shim: the composition root holds both and hands one to the
 * other.
 */
export interface RoutingCore {
  routeLayout(
    nodes: readonly SpatialNode[],
    edges: readonly RoutableElement[],
    styleOf: (edge: RoutableElement) => EdgeRoutingStyle,
    overrides: ReadonlyMap<string, EdgeAnchorOverride> | undefined,
    budget: RoutingBudget,
    labels: readonly Rect[],
  ): RoutedLayout
}

/** What reproduces one routing call: everything it read, the budget as it was before. */
interface RouteLayoutRepro {
  readonly nodes: readonly SpatialNode[]
  readonly edges: readonly RoutableElement[]
  readonly styles: readonly EdgeRoutingStyle[]
  readonly overrides: readonly (readonly [string, EdgeAnchorOverride])[] | undefined
  readonly budget: RoutingBudget
  readonly labels: readonly Rect[]
}

/**
 * A difference `differential` mode found, or a core that refused a call.
 * `at` is the first position the two canonical answers part at; the
 * answers are given whole so the report needs nothing else to be read.
 */
export type CoreMismatch =
  | CanvasLayoutMismatch
  | {
      readonly fn: 'routeLayout'
      readonly kind: 'differs'
      readonly at: number
      readonly ts: readonly (number | string)[]
      readonly rust: readonly (number | string)[]
      readonly repro: RouteLayoutRepro
    }
  | {
      readonly fn: 'routeLayout'
      readonly kind: 'refused'
      readonly err: unknown
      readonly repro: RouteLayoutRepro
    }

/**
 * The Rust core as a layout is handed it (`SpatialLayoutOptions.core`): the
 * implementation, the switch per ported function, and where a mismatch is
 * reported. canvas-render has no logger, so a mismatch reaches nobody the
 * root did not name.
 */
export interface LayoutCore {
  readonly routing: RoutingCore
  /**
   * The whole layout in one call (`layoutSpatialCanvasWithAnchors`), with its
   * own switch: absent, either reads `ts`.
   */
  readonly layout?: CanvasLayoutCore
  readonly impl: { readonly routeLayout: CoreImpl; readonly layoutSpatialCanvas?: CoreImpl }
  readonly onMismatch?: (mismatch: CoreMismatch) => void
}

/** What the composer does between the side search and drawing: every edge routed on one budget. */
function routeLayoutTs(
  nodes: readonly SpatialNode[],
  edges: readonly RoutableElement[],
  styleOf: (edge: RoutableElement) => EdgeRoutingStyle,
  overrides: ReadonlyMap<string, EdgeAnchorOverride> | undefined,
  budget: RoutingBudget,
  labels: readonly Rect[],
): RoutedLayout {
  const anchors = assignEdgeAnchors(nodes, edges, styleOf, overrides, budget, labels)
  const routes = edges.map((edge) =>
    routeEdge(nodes, edge, styleOf(edge), anchors.get(edge.id), undefined, budget, labels),
  )
  return { routes, anchors }
}

const point = (p: { readonly x: number; readonly y: number } | undefined) =>
  p === undefined ? ['-'] : [p.x, p.y]
const optional = (v: string | number | undefined) => (v === undefined ? '-' : v)

/**
 * A routing answer as one flat list, every field in a fixed order, so two
 * answers compare position by position whatever order their objects' keys
 * were written in. Anchors are read in key order for the same reason: the
 * map's insertion order is not part of what either side promises.
 */
function canonical(layout: RoutedLayout, budget: RoutingBudget): (number | string)[] {
  const routes = layout.routes.flatMap((r) => [
    r.id ?? '-',
    r.rounded === true ? 1 : 0,
    optional(r.fromSide),
    optional(r.toSide),
    optional(r.fromEnd),
    optional(r.toEnd),
    r.path.length,
    ...r.path.flatMap((p) => [p.x, p.y]),
  ])
  const anchors = [...layout.anchors.keys()].sort().flatMap((id) => {
    const a = layout.anchors.get(id) as EdgeAnchorPair
    return [
      id,
      ...point(a.from),
      ...point(a.to),
      optional(a.fromLaneDepth),
      optional(a.toLaneDepth),
      optional(a.fromSide),
      optional(a.toSide),
      a.around === true ? 1 : 0,
    ]
  })
  return [
    budget.grid,
    budget.pairs,
    budget.trials,
    budget.repairs,
    layout.routes.length,
    ...routes,
    layout.anchors.size,
    ...anchors,
  ]
}

const firstDifference = (a: readonly unknown[], b: readonly unknown[]): number | undefined => {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) if (!Object.is(a[i], b[i])) return i
  return undefined
}

/**
 * One layout's edge routing, answered as `core` says: by the TypeScript
 * when no core is given or its switch reads `ts`, by the core under `rust`,
 * and under `differential` by the TypeScript with the core run beside it on
 * a copy of the budget. A core that throws is reported and the TypeScript
 * answers, in either mode: a layout is total, and a refused call is the
 * shim's defect, never the canvas's.
 */
export function routeLayout(
  core: LayoutCore | undefined,
  nodes: readonly SpatialNode[],
  edges: readonly RoutableElement[],
  styleOf: (edge: RoutableElement) => EdgeRoutingStyle,
  overrides: ReadonlyMap<string, EdgeAnchorOverride> | undefined,
  budget: RoutingBudget,
  labels: readonly Rect[],
): RoutedLayout {
  const impl = core?.impl.routeLayout ?? 'ts'
  if (core === undefined || impl === 'ts') {
    return routeLayoutTs(nodes, edges, styleOf, overrides, budget, labels)
  }
  const before = { ...budget }
  const repro = (): RouteLayoutRepro => ({
    nodes,
    edges,
    styles: edges.map(styleOf),
    overrides: overrides === undefined ? undefined : [...overrides],
    budget: before,
    labels,
  })
  const coreBudget = { ...budget }
  let rust: RoutedLayout
  try {
    rust = core.routing.routeLayout(nodes, edges, styleOf, overrides, coreBudget, labels)
  } catch (err) {
    core.onMismatch?.({ fn: 'routeLayout', kind: 'refused', err, repro: repro() })
    return routeLayoutTs(nodes, edges, styleOf, overrides, budget, labels)
  }
  if (impl === 'rust') {
    Object.assign(budget, coreBudget)
    return rust
  }
  const ts = routeLayoutTs(nodes, edges, styleOf, overrides, budget, labels)
  const tsValues = canonical(ts, budget)
  const rustValues = canonical(rust, coreBudget)
  const at = firstDifference(tsValues, rustValues)
  if (at !== undefined) {
    core.onMismatch?.({
      fn: 'routeLayout',
      kind: 'differs',
      at,
      ts: tsValues,
      rust: rustValues,
      repro: repro(),
    })
  }
  return ts
}
