import {
  installOkfCore,
  installSpatialCore,
  okfCoreInstalled,
  spatialCoreInstalled,
} from '@kamiazya/whiteboard-codec'
import { getAppLogger } from './app-logger.js'
import { installLayoutCore } from './spatial/layout-core.js'

/**
 * Settles once this realm answers OKF and JSON Canvas: codec's `parseOkf` /
 * `serializeOkf` and `parseSpatial` / `serializeSpatial` have no TypeScript
 * behind them, so every call site awaits this first. The page starts loading the
 * wasm at boot (`page-layout-core.ts`), so by the time someone imports a file it
 * has usually settled. A realm whose cores are already installed (a test realm)
 * returns at once; a load that fails rejects, since there is nothing to answer in
 * its place. Its own module, not `layout-core.ts`'s, so the codecs stay off the
 * page's critical path.
 */
export async function codecsReady(): Promise<void> {
  if (okfCoreInstalled() && spatialCoreInstalled()) return
  const core = await installLayoutCore(getAppLogger('layout-core')).codecs()
  if (!okfCoreInstalled()) installOkfCore(core)
  if (!spatialCoreInstalled()) installSpatialCore(core)
}
