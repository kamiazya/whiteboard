import { act, cleanup, render as rtlRender, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserLocalCanvasPath } from '../lib/app-routes.js'
import { MemoryStore } from '../lib/browser-local-store.js'
import type { CanvasSnapshot } from '../lib/whiteboard-client.js'
import { BrowserLocalCanvasPage } from './BrowserLocalCanvasPage.js'

// Exposes react-router's navigate() to the test so it can drive the page's
// URL -> canvas id effect (the same path a Back/Forward navigation or the
// switcher's push takes) without needing to click through the real
// WorkspaceTopBar switcher UI.
let capturedNavigate: ((path: string) => void) | null = null
function NavigateCapture() {
  const navigate = useNavigate()
  capturedNavigate = (path: string) => navigate(path)
  return null
}

function render(ui: ReactElement) {
  return rtlRender(
    <MemoryRouter initialEntries={['/']}>
      <NavigateCapture />
      {ui}
    </MemoryRouter>,
  )
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

const snap2: CanvasSnapshot = {
  id: 'c2',
  name: 'second',
  updatedAt: '2026-05-24T00:00:00.000Z',
}

describe('BrowserLocalCanvasPage file upload notification', () => {
  afterEach(() => {
    cleanup()
    capturedOptions = {}
    capturedNavigate = null
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

  it('clears the failure notification once onFileUploadSucceeded fires', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    await act(async () => {
      render(<BrowserLocalCanvasPage store={store} />)
    })

    await act(async () => {
      capturedOptions.onFileUploadFailed?.()
    })
    expect(screen.getByRole('alert')).toBeTruthy()

    await act(async () => {
      capturedOptions.onFileUploadSucceeded?.()
    })

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('clears a stale upload-failure banner when the user switches to a different canvas', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    await store.save(snap2)
    await act(async () => {
      render(<BrowserLocalCanvasPage store={store} />)
    })

    await act(async () => {
      capturedOptions.onFileUploadFailed?.()
    })
    expect(screen.getByRole('alert')).toBeTruthy()

    await act(async () => {
      capturedNavigate?.(browserLocalCanvasPath('c2'))
    })

    expect(screen.queryByRole('alert')).toBeNull()
  })
})
