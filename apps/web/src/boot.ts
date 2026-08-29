/**
 * The app's real boot chain, factored out of main.tsx so the resolver-
 * rejection path is testable through the ACTUAL sequence rather than a
 * re-implementation a test could drift from.
 *
 * The workspace-id resolver runs alongside render rather than gating it: no
 * IndexedDB open has ever gated boot (every browser-workspace call site
 * already isolates a failed open locally — see e.g. workspace-content.ts's
 * `.open(...).catch(() => null)`), and a daemon-only route must not
 * white-screen because THIS tab's browser storage is unavailable (a stale
 * tab blocking the v14 upgrade, a quota failure, Safari private browsing).
 * `resolveBrowserWorkspaceId()` caches the rejection's cause itself, so
 * swallowing it here for boot purposes only still lets every later
 * `getBrowserWorkspaceId()` read throw that cause into whichever browser-
 * workspace consumer reads the accessor next — landing in that consumer's
 * existing local error isolation, not a new one invented for this path.
 */
import { ensureViewerFontLoaded } from '@kamiazya/whiteboard-canvas-viewer/font-loading'
import { createElement, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App.js'
import { dismissBootSplash } from './boot-splash.js'
import { getAppLogger } from './lib/app-logger.js'
import { resolveBrowserWorkspaceId } from './lib/browser-workspace-id.js'

const log = getAppLogger('boot')

export interface BootSequenceOptions {
  rootEl: HTMLElement
  resolveWorkspaceId?: () => Promise<string>
  loadFont?: () => Promise<unknown>
  dismissSplash?: () => Promise<void>
  render?: (root: HTMLElement) => void
}

function renderApp(root: HTMLElement): void {
  createRoot(root).render(
    createElement(StrictMode, null, createElement(BrowserRouter, null, createElement(App))),
  )
}

export async function startBootSequence({
  rootEl,
  resolveWorkspaceId = () => resolveBrowserWorkspaceId(),
  loadFont = ensureViewerFontLoaded,
  dismissSplash = () => dismissBootSplash(),
  render = renderApp,
}: BootSequenceOptions): Promise<void> {
  await loadFont()
  await resolveWorkspaceId().catch((cause: unknown) => {
    log.warn('browser workspace id resolution failed; rendering degraded', cause)
  })
  await dismissSplash()
  render(rootEl)
}
