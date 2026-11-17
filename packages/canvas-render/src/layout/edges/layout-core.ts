import type { EdgeRoutingStyle, SpatialNode } from '@kamiazya/whiteboard-model'
import type { ResolvedEdgeNode, RoutableElement } from '@kamiazya/whiteboard-scene'
import type { CanvasLayoutCore } from '../../canvas-core.js'
import type { MarkdownLayoutCore } from '../../markdown-core.js'
import type { QueryLayoutCore } from '../../query-core.js'
import type { Rect } from './edge-geometry.js'
import { routeEdge } from './edge-router.js'
import type { EdgeAnchorOverride, EdgeAnchorPair } from './edge-sides.js'
import type { RoutingBudget } from './routing-budget.js'
import { assignEdgeAnchors } from './spatial-edges.js'

/** One layout's routes, in input order, and the anchors the side search settled. */
interface RoutedLayout {
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

/**
 * The Rust core as a layout is handed it (`SpatialLayoutOptions.core`): one
 * implementation behind each entry, which a composition root holds and hands
 * over. Every layout, note and query is the core's: `SpatialLayoutOptions.core`
 * is required, and there is no TypeScript composer behind it (ADR-0054 step 7,
 * S18h). The one layout piece whose TypeScript remains is the edge routing
 * (`routeLayout`, ledgered at stage 2, over `assignEdgeAnchors` and
 * `routeEdge`), which the web editor's connect preview runs in a realm that
 * holds no core.
 */
export interface LayoutCore {
  /** An edge set routed in one call (`routeLayout`). */
  readonly routing: RoutingCore
  /** The whole layout in one call (`layoutSpatialCanvasWithAnchors`). */
  readonly layout: CanvasLayoutCore
  /** A markdown note or a comment's prose in one call (`layoutMarkdownDocument`). */
  readonly markdown: MarkdownLayoutCore
  /**
   * The layout pieces a root calls on their own (the drag frame's edge layer,
   * a node's size, a label's place, a bubble's, a body overlay's box).
   */
  readonly query: QueryLayoutCore
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

/**
 * One layout's edge routing: by the core when one is given, its budget
 * written back as the TypeScript's would be, else by the TypeScript routing
 * (`routeLayoutTs`), which stays at stage 2 while ADR-0054 step 7 keeps it.
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
  if (core === undefined) return routeLayoutTs(nodes, edges, styleOf, overrides, budget, labels)
  return core.routing.routeLayout(nodes, edges, styleOf, overrides, budget, labels)
}
