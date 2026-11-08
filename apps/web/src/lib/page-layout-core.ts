import { getAppLogger } from './app-logger.js'
import { installLayoutCore, layoutCoreReady } from './spatial/layout-core.js'

/**
 * Installs this realm's routing core under the app logger and starts loading
 * it, so the first layout that asks finds it loaded. The page calls it at
 * boot and the layout worker at start-up; neither waits for it here, and a
 * failed load is reported again by whatever asks for the core next.
 */
export function startLayoutCore(): void {
  installLayoutCore(getAppLogger('layout-core'))
  layoutCoreReady().catch(() => undefined)
}
