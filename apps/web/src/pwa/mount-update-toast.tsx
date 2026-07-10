import { createRoot } from 'react-dom/client'
import { UpdateToast } from './UpdateToast.js'

// Module-level, not component state: a dismissed update stays dismissed for
// the rest of this page load even if the SW fires onNeedRefresh again
// (e.g. a second background update). Reset only happens on a fresh page
// load (fresh module evaluation), matching the "reload swaps versions"
// update strategy — a user who dismissed keeps the old version until they
// reload by some other means.
let dismissedThisPageLoad = false

const PORTAL_ID = 'pwa-update-toast-portal'

export function mountUpdateToast(updateServiceWorker: (reloadPage?: boolean) => void): void {
  if (dismissedThisPageLoad) return

  let container = document.getElementById(PORTAL_ID)
  if (!container) {
    container = document.createElement('div')
    container.id = PORTAL_ID
    document.body.appendChild(container)
  }

  const root = createRoot(container)
  root.render(
    <UpdateToast
      onReload={() => updateServiceWorker(true)}
      onDismiss={() => {
        dismissedThisPageLoad = true
        root.unmount()
        container?.remove()
      }}
    />,
  )
}
