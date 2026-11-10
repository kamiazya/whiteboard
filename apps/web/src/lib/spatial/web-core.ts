import type { RoutingCore } from '@kamiazya/whiteboard-canvas-render'
import type { OkfCodecCore, SpatialCodecCore } from '@kamiazya/whiteboard-codec'

/**
 * What the Rust core answers in a realm: the routing call, the OKF envelope
 * and the JSON Canvas codec, from one instance. Its own module so the loader and the host
 * can both name it without importing each other.
 */
export type WebCore = RoutingCore & OkfCodecCore['okf'] & SpatialCodecCore['spatial']
