import type { RegisterSWOptions } from 'vite-plugin-pwa/types'
import { getAppLogger } from '../lib/app-logger.js'

const log = getAppLogger('register-sw')

type ImportRegisterModule = () => Promise<{
  registerSW: (options?: RegisterSWOptions) => (reloadPage?: boolean) => Promise<void>
}>

export interface SetupSwRegistrationOptions {
  isProd: boolean
  hasServiceWorker: boolean
  /**
   * True when this document came from the local daemon rather than the hosted
   * app. The daemon serves exactly one page (/pair) and redirects every other
   * path to the hosted app, so `/sw.js` there answers 302 to a different
   * origin: registering makes the browser fetch the hosted app's HTML as a
   * worker script. That request can never succeed, and under the page's CSP it
   * is blocked outright and never settles, stranding the dynamic import below.
   * The PWA is a hosted-app concern; a consent page has nothing to cache.
   */
  isDaemonServed: boolean
  importRegister: ImportRegisterModule
}

// Registration is deferred behind `window`'s 'load' event and a dynamic
// `import('virtual:pwa-register')` so the (small) registration glue never
// enters the eagerly-loaded entry chunk — the entry gzip budget is razor
// thin (see scripts/smoke-bundle-size.mjs).
//
// isProd gates registration entirely: registering a SW in `vite dev` would
// let a stale worker keep intercepting requests across dev-server restarts.
export function setupSwRegistration({
  isProd,
  hasServiceWorker,
  isDaemonServed,
  importRegister,
}: SetupSwRegistrationOptions): void {
  if (!isProd || !hasServiceWorker || isDaemonServed) return

  const register = () => {
    void importRegister()
      .then(({ registerSW }) => {
        const updateServiceWorker = registerSW({
          onNeedRefresh: () => {
            // The toast UI (React component + createRoot) is only needed on
            // the rare "an update is available" path, so it stays out of the
            // entry chunk via a dynamic import too.
            void import('./mount-update-toast.js')
              .then(({ mountUpdateToast }) => {
                mountUpdateToast(updateServiceWorker)
              })
              .catch((err: unknown) => {
                log.error('failed to load the update toast module', err)
              })
          },
          onRegisteredSW: (_swScriptUrl, registration) => {
            // A long-open or quickly-reloaded tab may never re-check sw.js on
            // its own cadence, so a deploy can go unnoticed indefinitely.
            // Scheduling periodic + focus-triggered `registration.update()`
            // calls is what turns a deploy into an onNeedRefresh toast within
            // one interval tick or tab refocus. The scheduler module stays
            // out of the entry chunk via this dynamic import, matching the
            // update-toast module above.
            if (!registration) return
            void import('./sw-update-scheduler.js')
              .then(({ startSwUpdateScheduler }) => {
                startSwUpdateScheduler({ update: () => registration.update() })
              })
              .catch((err: unknown) => {
                log.error('failed to load the service worker update scheduler', err)
              })
          },
        })
      })
      .catch((err: unknown) => {
        log.error('failed to register the service worker', err)
      })
  }

  // The entry module graph contains top-level await (loro WASM init), so this
  // code can run AFTER window 'load' has already fired — a load listener
  // alone would then never fire and the SW would silently never register.
  if (document.readyState === 'complete') {
    register()
    return
  }
  window.addEventListener('load', register, { once: true })
}
