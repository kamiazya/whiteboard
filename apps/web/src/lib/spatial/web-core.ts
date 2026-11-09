import type { RoutingCore } from '@kamiazya/whiteboard-canvas-render'
import type { OkfCodecCore } from '@kamiazya/whiteboard-codec'

/**
 * What the Rust core answers in a realm: the routing call and the OKF
 * envelope, from one instance. Its own module so the loader and the host
 * can both name it without importing each other.
 */
export type WebCore = RoutingCore & OkfCodecCore['okf']
