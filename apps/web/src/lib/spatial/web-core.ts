import type {
  CanvasLayoutCore,
  MarkdownLayoutCore,
  QueryLayoutCore,
  RoutingCore,
} from '@kamiazya/whiteboard-canvas-render'
import type { OkfCore, SpatialCore } from '@kamiazya/whiteboard-codec'
import type { SearchCore } from '@kamiazya/whiteboard-search'

/**
 * What the Rust core answers in a realm: the routing call, the whole layout,
 * a markdown note, the layout pieces an editor asks on their own, the OKF
 * envelope, the JSON Canvas codec and lexical search, from one instance. Its own module so the
 * loader and the host can both name it without importing each other.
 */
export type WebCore = RoutingCore &
  CanvasLayoutCore &
  MarkdownLayoutCore &
  QueryLayoutCore &
  OkfCore &
  SpatialCore & { readonly search: SearchCore }
