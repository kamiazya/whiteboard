import { getAppLogger } from './app-logger.js'
import { searchReady } from './search-core.js'
import { installLayoutCore, layoutCoreReady } from './spatial/layout-core.js'

/**
 * Installs this realm's Rust core and settles once it has loaded, so the first
 * layout finds it: the page awaits it at boot and the layout worker before its
 * first message. A load that fails, or has not settled within
 * `CORE_LOAD_TIMEOUT_MS` (a stalled fetch), is logged here and settles all
 * the same, so the page still renders: every layout after it draws the
 * missing-core notice (`CORE_UNAVAILABLE`), since there is no TypeScript to
 * answer in the core's place, and a later layout asks for the core again.
 * The same instance answers search, installed here so the file list, which
 * filters as someone types, finds it ready.
 */
export function startLayoutCore(): Promise<void> {
  installLayoutCore()
  return layoutCoreReady().then(
    () => searchReady(),
    (err: unknown) => {
      getAppLogger('layout-core').error('the Rust core did not load; nothing can be laid out', err)
    },
  )
}
