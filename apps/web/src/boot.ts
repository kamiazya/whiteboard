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
// Deliberately the narrow subpath, not the package barrel: the barrel
// re-exports CanvasViewer and the scene codec, which drag canvas-render and
// codec's remark pipeline onto the critical path for a module that only needs
// the font loader. The bundle-size gate fails if this regresses.
import { ensureViewerFontLoaded } from '@kamiazya/whiteboard-canvas-viewer/font-loading'
import { createElement, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App.js'
import { dismissBootSplash } from './boot-splash.js'
import { TouchFormattingBar } from './components/markdown-editor/TouchFormattingBar.js'
import { getAppLogger } from './lib/app-logger.js'
import { parseWorkspaceRoute } from './lib/app-routes.js'
import { resolveBrowserWorkspaceId } from './lib/browser-workspace-id.js'

const log = getAppLogger('boot')

/**
 * Matches the viewer font's own budget: both bound a first-paint wait on
 * something that usually takes milliseconds, and neither is a delay — nothing
 * that succeeds is slowed by it.
 */
const WORKSPACE_ID_RESOLVE_TIMEOUT_MS = 3000

export interface BootSequenceOptions {
  rootEl: HTMLElement
  resolveWorkspaceId?: () => Promise<string>
  loadFont?: () => Promise<unknown>
  dismissSplash?: () => Promise<void>
  render?: (root: HTMLElement) => void
}

function renderApp(root: HTMLElement): void {
  createRoot(root).render(
    createElement(
      StrictMode,
      null,
      createElement(BrowserRouter, null, createElement(App)),
      // Once, beside the app: it follows the focused markdown editor through
      // the active-editor registry and renders nothing until a phone's
      // keyboard is up.
      createElement(TouchFormattingBar),
    ),
  )
}

export async function startBootSequence({
  rootEl,
  // The DEFAULT is the only caller that can hand the resolver a handle, and
  // the address is where a handle comes from: which workspace this session
  // opens is the URL's to say (ADR-0019), not the registry's to pick.
  resolveWorkspaceId = () =>
    resolveBrowserWorkspaceId(undefined, parseWorkspaceRoute(window.location.pathname)?.workspace),
  loadFont = ensureViewerFontLoaded,
  dismissSplash = () => dismissBootSplash(),
  render = renderApp,
}: BootSequenceOptions): Promise<void> {
  // Bounded await: every on-screen text measurement (SpatialEditor,
  // MarkdownEditor's preview pane, useDocumentSync) must use the same vendored
  // Roboto face the Node export pipeline measures, or wrapped-line counts and
  // content sizing silently diverge between what a user sees and what they
  // export. This is the one seam that covers all three, including
  // useDocumentSync's non-React measurer construction. ensureViewerFontLoaded()
  // bounds the wait itself (VIEWER_FONT_LOAD_TIMEOUT_MS), so a stalled font
  // fetch delays first paint by at most that bound rather than hanging
  // indefinitely — first paint then proceeds with fallback system-font metrics
  // and self-corrects once the font finishes loading in the background (see
  // CanvasViewer's useViewerFontReady for that path).
  await loadFont()
  // Bounded, for the same reason the font load is: an IndexedDB open can fail
  // by never settling as easily as by rejecting — a `deleteDatabase` in
  // another tab, a browser that leaves the request pending under storage
  // pressure — and an unbounded await there holds the splash forever, which
  // is the one outcome worse than rendering without the id.
  //
  // Bounded rather than not awaited at all: on every normal load the resolve
  // wins this race by orders of magnitude, and awaiting it is what guarantees
  // no consumer reads the accessor unresolved. Dropping the await to fix the
  // hang would trade a rare stall for a routine race.
  await Promise.race([
    resolveWorkspaceId().catch((cause: unknown) => {
      log.warn('browser workspace id resolution failed; rendering degraded', cause)
    }),
    new Promise<void>((resolve) => {
      setTimeout(() => {
        log.warn('browser workspace id resolution did not settle; rendering degraded')
        resolve()
      }, WORKSPACE_ID_RESOLVE_TIMEOUT_MS)
    }),
  ])
  // Paces the index.html splash: the app is ready at this point, but the
  // splash stays up until its draw animation lands plus a beat, and fades out
  // before React's first commit replaces it.
  await dismissSplash()
  render(rootEl)
}
