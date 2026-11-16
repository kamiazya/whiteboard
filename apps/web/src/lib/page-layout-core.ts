import { getAppLogger } from './app-logger.js'
import { installLayoutCore, layoutCoreReady } from './spatial/layout-core.js'

/**
 * Installs this realm's Rust core and settles once it has loaded, so the first
 * layout finds it: the page awaits it at boot and the layout worker before its
 * first message. A load that fails is logged here and settles all the same, so
 * the page still renders; every layout after it throws the failure again
 * (`currentLayoutCore`), which is the error its surface shows, since there is
 * no TypeScript to answer in the core's place.
 */
export function startLayoutCore(): Promise<void> {
  installLayoutCore()
  return layoutCoreReady().then(
    () => undefined,
    (err: unknown) => {
      getAppLogger('layout-core').error('the Rust core did not load; nothing can be laid out', err)
    },
  )
}
