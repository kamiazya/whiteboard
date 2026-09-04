import { getAppLogger } from '../lib/app-logger.js'

const log = getAppLogger('reload-fresh')

/**
 * Reload onto whatever the SERVER now serves, rather than onto the bundle
 * this page is already running.
 *
 * The distinction is not pedantic here. `apps/web` registers its Workbox
 * worker with `registerType: 'prompt'`, so a waiting worker holds its cached
 * chunks until something calls `skipWaiting` — and a plain
 * `location.reload()` never does. A page that reached the error screen
 * because the chunks it holds no longer agree with each other therefore
 * reloads straight back into the same broken bundle, which is the one thing
 * a recovery action must not do.
 *
 * Clearing is best-effort and never blocks the reload: storage access throws
 * outright in a browser set to block site data, and a reload the user cannot
 * reach is worse than a reload that skipped its cleaning.
 *
 * The reload itself is injected so a test can observe it — a real
 * `location.reload()` in jsdom navigates the test's own environment.
 */
export async function reloadFresh(
  reload: () => void = () => window.location.reload(),
): Promise<void> {
  try {
    const registrations = await navigator.serviceWorker?.getRegistrations()
    for (const registration of registrations ?? []) await registration.unregister()
  } catch (err) {
    log.warn('could not drop the service worker before reloading', err)
  }
  try {
    // `caches` is absent in a private window and in browsers without the API.
    const keys = await globalThis.caches?.keys()
    for (const key of keys ?? []) await globalThis.caches.delete(key)
  } catch (err) {
    log.warn('could not clear the caches before reloading', err)
  }
  reload()
}
