import { createRoot, type Root } from 'react-dom/client'
import { UpdateToast } from './UpdateToast.js'

// Module-level, not component state: a dismissed update stays dismissed for
// the rest of this page load even if the SW fires onNeedRefresh again
// (e.g. a second background update). Reset only happens on a fresh page
// load (fresh module evaluation), matching the "reload swaps versions"
// update strategy — a user who dismissed keeps the old version until they
// reload by some other means.
let dismissedThisPageLoad = false

// Tracks the root already mounted for this page load so a repeat
// onNeedRefresh (e.g. a background update firing again before dismiss)
// re-renders into the existing root instead of calling createRoot() again
// on a container that already has one. React warns when createRoot() is
// called twice on the same DOM node, and the first root's fiber tree keeps
// referencing DOM nodes the second root's render has since replaced.
let activeRoot: Root | null = null

const PORTAL_ID = 'pwa-update-toast-portal'

export function mountUpdateToast(updateServiceWorker: (reloadPage?: boolean) => void): void {
  if (dismissedThisPageLoad) return

  let container = document.getElementById(PORTAL_ID)
  if (!container) {
    container = document.createElement('div')
    container.id = PORTAL_ID
    document.body.appendChild(container)
  }

  const root = activeRoot ?? createRoot(container)
  activeRoot = root
  root.render(
    <UpdateToast
      onReload={() => updateServiceWorker(true)}
      onDismiss={() => {
        dismissedThisPageLoad = true
        root.unmount()
        activeRoot = null
        container?.remove()
      }}
    />,
  )
}
