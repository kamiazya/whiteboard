// Must run before any module that pulls in @excalidraw/excalidraw.
import './excalidraw-asset-path.js'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App.js'
import { applyThemeClass, readPersistedTheme, resolveTheme } from './hooks/useThemeMode.js'
import { installUnloadShim } from './lib/unload-shim.js'
import './index.css'
import './pwa/bootstrap.js'

// Apply the persisted theme class before React mounts so the first paint
// matches the user's saved preference (avoids a light→dark flash on reload).
applyThemeClass(resolveTheme(readPersistedTheme()))

// Must run before Excalidraw's App component mounts (componentDidMount
// registers a window `unload` listener) — see src/lib/unload-shim.ts.
installUnloadShim()

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found')

createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
