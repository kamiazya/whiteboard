// Must run before any module that pulls in @excalidraw/excalidraw.
import './excalidraw-asset-path.js'
import { ensureViewerFontLoaded } from '@kamiazya/whiteboard-canvas-viewer'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App.js'
import { applyThemeClass, readPersistedTheme, resolveTheme } from './hooks/useThemeMode.js'
import './index.css'
import { purgeLegacyReconnectCredentials } from './lib/purge-legacy-reconnect-credentials.js'
import './pwa/bootstrap.js'

// Unconditional, ahead of anything else: removes a credential a pre-removal
// build may have left in localStorage, independent of whether this tab ever
// opens the IndexedDB store (see purge-legacy-reconnect-credentials.ts).
purgeLegacyReconnectCredentials()

// Apply the persisted theme class before React mounts so the first paint
// matches the user's saved preference (avoids a light→dark flash on reload).
applyThemeClass(resolveTheme(readPersistedTheme()))

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found')

function renderApp(root: HTMLElement): void {
  createRoot(root).render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>,
  )
}

// Bounded await: every on-screen text measurement (SpatialEditor,
// MarkdownEditor's preview pane, useCanvasSync) must use the same vendored
// Roboto face the Node export pipeline measures, or wrapped-line counts and
// content sizing silently diverge between what a user sees and what they
// export. This is the one seam that covers all three, including
// useCanvasSync's non-React measurer construction. ensureViewerFontLoaded()
// bounds the wait itself (VIEWER_FONT_LOAD_TIMEOUT_MS), so a stalled font
// fetch delays first paint by at most that bound rather than hanging
// indefinitely — first paint then proceeds with fallback system-font
// metrics and self-corrects once the font finishes loading in the
// background (see CanvasViewer's useViewerFontReady for that path).
void ensureViewerFontLoaded().then(() => renderApp(rootEl))
