import { getAppLogger } from './app-logger.js'
import { installLayoutCore, layoutCoreReady, type TrapPolicy } from './spatial/layout-core.js'

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
export function startLayoutCore(options: { readonly traps?: TrapPolicy } = {}): Promise<void> {
  installLayoutCore(options)
  return layoutCoreReady().then(installSearch, (err: unknown) => {
    getAppLogger('layout-core').error('the Rust core did not load; nothing can be laid out', err)
  })
}

/**
 * Search's install rides the core's load, but its failure is its own: the page
 * renders without search (its callers degrade) rather than stalling boot, which
 * awaits this before the first render. The import is dynamic so the boot path
 * takes no new module: a static one made the search dispatch a chunk of its
 * own on the critical path.
 */
async function installSearch(): Promise<void> {
  try {
    await import('./search-core.js').then(({ searchReady }) => searchReady())
  } catch (err) {
    getAppLogger('layout-core').error('search did not install; searching is unavailable', err)
  }
}
