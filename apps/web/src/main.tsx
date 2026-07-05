// Must run before any module that pulls in @excalidraw/excalidraw.
import './excalidraw-asset-path.js'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './index.css'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found')

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
