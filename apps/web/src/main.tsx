// Must run before any module that pulls in @excalidraw/excalidraw.
import './excalidraw-asset-path.js'
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

createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
