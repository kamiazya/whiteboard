import type { RegisterSWOptions } from 'vite-plugin-pwa/types'
import { getAppLogger } from '../lib/app-logger.js'

const log = getAppLogger('register-sw')

type ImportRegisterModule = () => Promise<{
  registerSW: (options?: RegisterSWOptions) => (reloadPage?: boolean) => Promise<void>
}>

export interface SetupSwRegistrationOptions {
  isProd: boolean
  hasServiceWorker: boolean
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
  importRegister,
}: SetupSwRegistrationOptions): void {
  if (!isProd || !hasServiceWorker) return

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
