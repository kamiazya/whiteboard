import { type SpatialCodec, spatialCodec } from '@kamiazya/whiteboard-codec'
import { currentSpatialCore } from './spatial/layout-core.js'

/**
 * The JSON Canvas codec as this realm answers it now: through the core once it
 * has loaded and the switch asks for it, else in TypeScript. A realm that
 * never installed a core reads and writes in TypeScript. Its own module, as
 * `okf-codec.ts` is, so the codec stays off the page's critical path.
 */
export const currentSpatialCodec = (): SpatialCodec => spatialCodec(currentSpatialCore())
