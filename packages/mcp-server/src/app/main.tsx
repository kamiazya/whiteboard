import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.js'
// Tailwind v4 + shadcn base styles, including variables, resets, and utilities.
import './index.css'
import { applyThemeClass, readPersistedTheme, resolveTheme } from './hooks/useThemeMode.js'
import { enableBrowserTracing } from './lib/browser-tracing.js'

// Apply the saved theme before React mounts so the chrome paints in the right
// mode on cold load (no light-mode flash before useThemeMode's effect runs).
// Resolve `'system'` here too so OS-dark users do not see a light flash.
applyThemeClass(resolveTheme(readPersistedTheme()))

// Browser-side OpenTelemetry is opt-in. The dev console can flip the flag:
//   localStorage.setItem('whiteboard:otel', '1')          // console exporter
//   localStorage.setItem('whiteboard:otel-otlp', 'http://localhost:4318')
// Reload, and outgoing apiFetch calls start carrying a `traceparent` header
// that the daemon middleware uses to stitch end-to-end traces.
if (typeof window !== 'undefined') {
  window.__whiteboardEnableTracing = enableBrowserTracing
  if (window.localStorage.getItem('whiteboard:otel') === '1') {
    void enableBrowserTracing({
      otlpEndpoint: window.localStorage.getItem('whiteboard:otel-otlp') ?? undefined,
    })
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
)
