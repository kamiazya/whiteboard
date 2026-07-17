import { act, cleanup, render as rtlRender, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryStore } from '../lib/browser-local-store.js'
import type { CanvasSnapshot } from '../lib/whiteboard-client.js'
import { BrowserLocalCanvasPage } from './BrowserLocalCanvasPage.js'

function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>)
}

// Excalidraw requires a real browser (roughjs native bindings). Mock it in jsdom.
vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: () => <div data-testid="excalidraw-mock" />,
  restoreElements: (els: unknown[]) => els,
  CaptureUpdateAction: { NEVER: 'NEVER' },
  exportToBlob: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
}))

// Captures the options object BrowserLocalCanvasPage passes to useCanvasSync
// so the test can invoke onFileUploadFailed/onFileUploadSucceeded directly —
// isolating the page's notification-wiring from the full backend/doc flow
// already covered by useCanvasSync.test.ts and the browser-mode backend tests.
let capturedOptions: { onFileUploadFailed?: () => void; onFileUploadSucceeded?: () => void } = {}
vi.mock('../hooks/useCanvasSync.js', () => ({
  useCanvasSync: (
    _backend: unknown,
    options?: { onFileUploadFailed?: () => void; onFileUploadSucceeded?: () => void },
  ) => {
    capturedOptions = options ?? {}
    return {
      syncStatus: 'connected',
      setExcalidrawAPI: vi.fn(),
      onChange: vi.fn(),
      restoreInProgress: false,
      restoreLabel: null,
      clearLocalUndo: vi.fn(),
      exportScene: vi.fn(async () => null),
    }
  },
}))

vi.mock('../lib/browser-local-backend.js', () => ({
  BrowserLocalBackend: class {},
}))

const snap: CanvasSnapshot = {
  id: 'c1',
  name: 'untitled',
  updatedAt: '2026-05-24T00:00:00.000Z',
}

describe('BrowserLocalCanvasPage file upload notification', () => {
  afterEach(() => {
    cleanup()
    capturedOptions = {}
  })

  it('wires onFileUploadFailed into useCanvasSync and shows a visible notification when it fires', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    await act(async () => {
      render(<BrowserLocalCanvasPage store={store} />)
    })

    expect(capturedOptions.onFileUploadFailed).toBeInstanceOf(Function)
    expect(screen.queryByText(/could not save|failed to save|upload failed/i)).toBeNull()

    await act(async () => {
      capturedOptions.onFileUploadFailed?.()
    })

    expect(screen.getByRole('alert')).toBeTruthy()
  })
})
