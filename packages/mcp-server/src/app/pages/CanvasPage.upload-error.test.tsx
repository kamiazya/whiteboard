// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Excalidraw is heavy and not relevant to the upload-error wiring;
// stub it to a passthrough placeholder so the page mounts cleanly.
vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: () => null,
  exportToBlob: vi.fn(),
  CaptureUpdateAction: { NEVER: 'never' },
  restoreElements: vi.fn(),
}))
vi.mock('@excalidraw/excalidraw/index.css', () => ({}))

// Capture the options object passed to the hook so the test can fire
// the upload-failed / upload-succeeded callbacks at the right moment
// without going through the real websocket / Loro / fetch stack.
const captured: { options: Record<string, ((...args: unknown[]) => unknown) | undefined> } = {
  options: {},
}
vi.mock('../hooks/useWhiteboardSync.js', () => ({
  useWhiteboardSync: (
    _ws: string,
    _slug: string,
    options: Record<string, ((...args: unknown[]) => unknown) | undefined> = {},
  ) => {
    captured.options = options
    return {
      onApiReady: vi.fn(),
      onSceneChange: vi.fn(),
      clearLocalUndo: vi.fn(),
      restoreInProgress: false,
      restoreLabel: null,
    }
  },
}))

// Children that don't matter for this contract — keep them as no-ops
// so the page renders without dragging their fetch / branch / merge
// dependencies into the test.
vi.mock('../components/WorkspaceTopBar.js', () => ({
  default: () => null,
}))
vi.mock('../components/MergeToast.js', () => ({
  MergeToast: () => null,
}))
vi.mock('../components/MergeHighlight.js', () => ({
  MergeHighlight: () => null,
}))
vi.mock('../components/HeaderBranchBanner.js', () => ({
  HeaderBranchBanner: () => null,
}))

const { default: CanvasPage } = await import('./CanvasPage.js')

function renderCanvasPage(): void {
  render(
    <MemoryRouter initialEntries={['/canvas/sess_1/canvas-a']}>
      <Routes>
        <Route path="/canvas/:workspaceId/*" element={<CanvasPage /> as ReactNode} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  captured.options = {}
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('CanvasPage file-upload-error wiring', () => {
  it('renders the file-upload-error alert when the hook fires onFileUploadFailed', () => {
    renderCanvasPage()
    expect(screen.queryByTestId('file-upload-error')).toBeNull()

    act(() => {
      captured.options.onFileUploadFailed?.()
    })

    const alert = screen.getByTestId('file-upload-error')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent ?? '').toMatch(/could not upload/i)
    // The user-facing copy must not carry internal upload diagnostics.
    const txt = document.body.textContent ?? ''
    expect(txt).not.toMatch(/Authorization/i)
    expect(txt).not.toMatch(/Bearer/i)
    expect(txt).not.toContain('secret-token-XYZ')
    expect(txt).not.toMatch(/\/file\//)
    expect(txt).not.toMatch(/fileId/i)
    expect(txt).not.toContain('Problem Details')
  })

  it('clears the alert when the hook fires onFileUploadSucceeded', () => {
    renderCanvasPage()

    act(() => {
      captured.options.onFileUploadFailed?.()
    })
    expect(screen.getByTestId('file-upload-error')).toBeTruthy()

    act(() => {
      captured.options.onFileUploadSucceeded?.()
    })
    expect(screen.queryByTestId('file-upload-error')).toBeNull()
  })

  it('does not render the alert in the initial state', () => {
    renderCanvasPage()
    expect(screen.queryByTestId('file-upload-error')).toBeNull()
  })
})
