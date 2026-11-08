import type { EdgeSide } from '@kamiazya/whiteboard-model'

// The routing inputs canvas-render's composer hands its edge pass, declared
// structurally so its own types are assignable without this package
// importing it: canvas-render will take this package's implementation
// through its layout options, and the dependency must point that way.

/** The four accounts a layout's routing may spend (`routing-budget.ts`). */
export interface RoutingBudget {
  grid: number
  pairs: number
  trials: number
  repairs: number
}

/** A frozen side choice and its pinned anchors (`EdgeAnchorOverride`). */
export interface SideOverride {
  readonly fromSide: EdgeSide
  readonly toSide: EdgeSide
  readonly around?: true
  readonly from?: { readonly x: number; readonly y: number }
  readonly fromLaneDepth?: number
  readonly to?: { readonly x: number; readonly y: number }
  readonly toLaneDepth?: number
}

/** A box a route must not cross, such as a frame's title. */
export interface LabelRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** Where the search settled one edge's ends (`EdgeAnchorPair`). */
export interface AnchorPair {
  readonly from?: { readonly x: number; readonly y: number }
  readonly to?: { readonly x: number; readonly y: number }
  readonly fromLaneDepth?: number
  readonly toLaneDepth?: number
  readonly fromSide?: EdgeSide
  readonly toSide?: EdgeSide
  readonly around?: true
}
