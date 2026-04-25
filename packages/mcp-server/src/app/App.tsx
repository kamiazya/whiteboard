import React from 'react'
import { Routes, Route } from 'react-router-dom'
import IndexPage from './pages/IndexPage.js'
import CanvasPage from './pages/CanvasPage.js'
import { ErrorBoundary } from './components/ErrorBoundary.js'

export default function App() {
  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/" element={<IndexPage />} />
        <Route
          path="/canvas/:sessionId/*"
          element={
            <ErrorBoundary>
              <CanvasPage />
            </ErrorBoundary>
          }
        />
      </Routes>
    </ErrorBoundary>
  )
}
