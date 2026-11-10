import { installOkfCore, okfCoreInstalled } from '@kamiazya/whiteboard-codec'
import { getAppLogger } from './app-logger.js'
import { installLayoutCore } from './spatial/layout-core.js'

/**
 * Settles once this realm answers OKF: codec's `parseOkf` / `serializeOkf`
 * have no TypeScript behind them, so every call site awaits this first. The
 * page starts loading the wasm at boot (`page-layout-core.ts`), so by the time
 * someone imports a file it has usually settled. A realm whose core is already
 * installed (a test realm) returns at once; a load that fails rejects, since
 * there is nothing to answer in its place. Its own module, not
 * `layout-core.ts`'s, so the codec stays off the page's critical path.
 */
export async function okfReady(): Promise<void> {
  if (okfCoreInstalled()) return
  installOkfCore(await installLayoutCore(getAppLogger('layout-core')).okf())
}
