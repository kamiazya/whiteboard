import type { EdgeRoutingStyle, SpatialNode } from '@kamiazya/whiteboard-model'
import type { ResolvedEdgeNode, RoutableElement } from '@kamiazya/whiteboard-scene'
import type { CanvasLayoutCore } from './canvas-core.js'
import type { EdgeAnchorOverride, EdgeAnchorPair, RoutingBudget } from './edge-routing.js'
import type { Rect } from './generated/geometry.zod.js'
import type { MarkdownLayoutCore } from './markdown-core.js'
import type { QueryLayoutCore } from './query-core.js'

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
 * over. Every layout, note, query and edge route is the core's, and there is
 * no TypeScript behind any of them (ADR-0054 step 7, S18h).
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

/**
 * One edge set's routing, asked of the core a caller hands it: the side
 * search over every edge, then every route on one budget, which the core
 * writes back. The web editor's connect preview routes its tentative edge
 * this way, outside any layout.
 */
export function routeLayout(
  core: LayoutCore,
  nodes: readonly SpatialNode[],
  edges: readonly RoutableElement[],
  styleOf: (edge: RoutableElement) => EdgeRoutingStyle,
  overrides: ReadonlyMap<string, EdgeAnchorOverride> | undefined,
  budget: RoutingBudget,
  labels: readonly Rect[],
): RoutedLayout {
  return core.routing.routeLayout(nodes, edges, styleOf, overrides, budget, labels)
}
