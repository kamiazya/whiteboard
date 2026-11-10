import {
  installOkfCore,
  type OkfCodec,
  type OkfCodecCore,
  parseOkf,
  serializeOkf,
} from '@kamiazya/whiteboard-codec'
import { currentOkfCore } from './spatial/layout-core.js'

/** The core this realm last installed as codec's plain-export core, so a repeat call installs nothing. */
let installedCore: OkfCodecCore | undefined

/**
 * The OKF envelope as this realm answers it now: through the core once it
 * has loaded and the switch asks for it, else in TypeScript. A realm that
 * never installed a core reads and writes in TypeScript. Its own module, not
 * `layout-core.ts`'s, so the codec stays off the page's critical path.
 *
 * Asking installs a core that has loaded as codec's own, and answers with
 * codec's plain `parseOkf` / `serializeOkf`, which dispatch through whatever
 * is installed: the realm's loaded core, or the one a test realm installed.
 */
export const currentOkfCodec = (): OkfCodec => {
  const core = currentOkfCore()
  if (core !== installedCore) {
    installOkfCore(core)
    installedCore = core
  }
  return { parseOkf, serializeOkf }
}
