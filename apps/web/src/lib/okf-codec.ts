import { type OkfCodec, okfCodec } from '@kamiazya/whiteboard-codec'
import { currentOkfCore } from './spatial/layout-core.js'

/**
 * The OKF envelope as this realm answers it now: through the core once it
 * has loaded and the switch asks for it, else in TypeScript. A realm that
 * never installed a core reads and writes in TypeScript. Its own module, not
 * `layout-core.ts`'s, so the codec stays off the page's critical path.
 */
export const currentOkfCodec = (): OkfCodec => okfCodec(currentOkfCore())
