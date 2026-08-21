/**
 * The sync session's lifetime is the backend object's identity, so whatever
 * the backend memo depends on becomes the session's lifetime. Only values
 * that define the connection may appear there: a rebuild means a fresh
 * hydrate and a cleared undo history for a canvas the user never left.
 *
 * This pins that for the browser-local page, where the injected `store` and
 * `loro` props are the tempting things to add.
 */

import type { DocumentBackendHandlers } from '@kamiazya/whiteboard-mcp/browser-contract'
import { act, cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { clearWhiteboardDb } from '../test-utils/browser-local-document.js'
import '../index.css'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'

claimIsolatedWhiteboardDb('browserlocaldocumentpage-backend-identity')

const constructedFor: string[] = []
const connectedFor: string[] = []

vi.mock('../lib/browser-local-backend.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/browser-local-backend.js')>(
    '../lib/browser-local-backend.js',
  )
  class RecordingBackend extends actual.BrowserLocalBackend {
    constructor(documentId: string) {
      super(documentId)
      constructedFor.push(documentId)
    }
    connect(handlers: DocumentBackendHandlers) {
      connectedFor.push('connect')
      return super.connect(handlers)
    }
  }
  return { ...actual, BrowserLocalBackend: RecordingBackend }
})

const { BrowserLocalDocumentPage } = await import('./BrowserLocalDocumentPage.js')

function render(ui: ReactElement) {
  return rtlRender(
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </div>,
  )
}

beforeEach(async () => {
  await clearWhiteboardDb()
  constructedFor.length = 0
  connectedFor.length = 0
})

afterEach(cleanup)

it('opens exactly one connection per canvas, and keeps it across a re-render', async () => {
  const { rerender } = render(<BrowserLocalDocumentPage store={new IdbDocumentIndex()} />)
  await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(), {
    timeout: 5000,
  })
  await waitFor(() => expect(constructedFor).toHaveLength(1), { timeout: 5000 })

  // A parent re-render handing over a fresh store instance — the injected
  // seam a future change would be tempted to key the backend on.
  await act(async () => {
    rerender(
      <div style={{ height: '100vh' }}>
        <MemoryRouter initialEntries={['/']}>
          <BrowserLocalDocumentPage store={new IdbDocumentIndex()} />
        </MemoryRouter>
      </div>,
    )
  })

  expect(constructedFor).toHaveLength(1)
  expect(connectedFor).toHaveLength(1)
})
