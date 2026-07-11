// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Excalidraw is heavy and not relevant to CanvasPage's own render logic;
// stub it to a lightweight marker so tests can assert the editor mounted
// without pulling in the real canvas engine.
vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: () => <div data-testid="excalidraw-stub" />,
  exportToBlob: vi.fn(),
  CaptureUpdateAction: { NEVER: 'never' },
  restoreElements: vi.fn(),
}))
vi.mock('@excalidraw/excalidraw/index.css', () => ({}))

// Mutable state read by the mocked hook on every render so tests can drive
// restoreInProgress / restoreLabel transitions across a rerender.
const hookState: { restoreInProgress: boolean; restoreLabel: string | null } = {
  restoreInProgress: false,
  restoreLabel: null,
}
vi.mock('../hooks/useWhiteboardSync.js', () => ({
  useWhiteboardSync: () => ({
    onApiReady: vi.fn(),
    onSceneChange: vi.fn(),
    clearLocalUndo: vi.fn(),
    restoreInProgress: hookState.restoreInProgress,
    restoreLabel: hookState.restoreLabel,
  }),
}))

vi.mock('../components/WorkspaceTopBar.js', () => ({
  default: () => <div data-testid="workspace-top-bar" />,
}))
vi.mock('../components/MergeToast.js', () => ({
  MergeToast: () => null,
}))
vi.mock('../components/MergeHighlight.js', () => ({
  MergeHighlight: () => null,
}))
vi.mock('../components/HeaderBranchBanner.js', () => ({
  HeaderBranchBanner: () => <div data-testid="header-branch-banner" />,
}))

// The canvases-list and libraries fetches are best-effort background loads;
// keep them pending forever by default so tests only exercise CanvasPage's
// own render branches, not the fetch resolution paths already covered by
// CanvasPage.abort.test.tsx.
const mockApiFetch = vi.fn()
vi.mock('../lib/api-client.js', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

const { default: CanvasPage } = await import('./CanvasPage.js')

function canvasPageTree() {
  return (
    <MemoryRouter initialEntries={['/canvas/sess_1/canvas-a']}>
      <Routes>
        <Route path="/canvas/:workspaceId/*" element={(<CanvasPage />) as ReactNode} />
      </Routes>
    </MemoryRouter>
  )
}

function renderCanvasPage() {
  return render(canvasPageTree())
}

beforeEach(() => {
  hookState.restoreInProgress = false
  hookState.restoreLabel = null
  mockApiFetch.mockClear()
  mockApiFetch.mockImplementation(() => new Promise(() => {}))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('CanvasPage main render path', () => {
  it('mounts the editor and top bar on initial render', async () => {
    renderCanvasPage()
    await act(async () => {})

    expect(screen.getByTestId('excalidraw-stub')).toBeTruthy()
    expect(screen.getByTestId('workspace-top-bar')).toBeTruthy()
    expect(screen.getByTestId('header-branch-banner')).toBeTruthy()
  })

  it('does not show the restore overlay while no restore is in progress', async () => {
    renderCanvasPage()
    await act(async () => {})

    expect(screen.queryByText(/restoring version/i)).toBeNull()
  })

  it('shows the restore-in-progress overlay when a version restore starts', async () => {
    hookState.restoreInProgress = true
    hookState.restoreLabel = 'v3 · 2 hours ago'

    renderCanvasPage()
    await act(async () => {})

    expect(screen.getByText(/restoring version/i)).toBeTruthy()
    expect(screen.getByText('v3 · 2 hours ago')).toBeTruthy()
    // The editor stays mounted underneath the overlay rather than unmounting.
    expect(screen.getByTestId('excalidraw-stub')).toBeTruthy()
  })

  it('transitions from the restore overlay back to the normal view when restore completes', async () => {
    hookState.restoreInProgress = true
    hookState.restoreLabel = 'v3 · 2 hours ago'
    const { rerender } = renderCanvasPage()
    await act(async () => {})
    expect(screen.getByText(/restoring version/i)).toBeTruthy()

    hookState.restoreInProgress = false
    hookState.restoreLabel = null
    rerender(canvasPageTree())
    await act(async () => {})

    expect(screen.queryByText(/restoring version/i)).toBeNull()
  })

  it('hides the chrome (top bar, branch banner) and shows the exit-fullscreen control when fullscreen is toggled on', async () => {
    renderCanvasPage()
    await act(async () => {})

    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'f', bubbles: true })
      window.dispatchEvent(event)
    })

    expect(screen.queryByTestId('workspace-top-bar')).toBeNull()
    expect(screen.queryByTestId('header-branch-banner')).toBeNull()
    expect(screen.getByTitle(/exit fullscreen/i)).toBeTruthy()
    // The editor itself keeps rendering while only the surrounding chrome hides.
    expect(screen.getByTestId('excalidraw-stub')).toBeTruthy()
  })
})
