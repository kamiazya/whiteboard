import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import '../index.css'

// Stub Excalidraw so the page mounts in the browser without the real editor,
// and so apiRef becomes ready (the library-import effect polls apiRef before
// firing its fetches).
const fakeApi = {
  updateLibrary: vi.fn(),
  getSceneElements: () => [{ id: 'el-1', type: 'rectangle' }],
  getAppState: () => ({}),
  getFiles: () => ({}),
}
vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: ({ excalidrawAPI }: { excalidrawAPI?: (api: unknown) => void }) => {
    excalidrawAPI?.(fakeApi)
    return null
  },
  exportToBlob: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
  CaptureUpdateAction: { NEVER: 'never' },
  restoreElements: vi.fn(),
}))

vi.mock('../hooks/useWhiteboardSync.js', () => ({
  useWhiteboardSync: () => ({
    onApiReady: vi.fn(),
    onSceneChange: vi.fn(),
    clearLocalUndo: vi.fn(),
    restoreInProgress: false,
    restoreLabel: null,
  }),
}))
vi.mock('../components/WorkspaceTopBar.js', () => ({ default: () => null }))
vi.mock('../components/MergeToast.js', () => ({ MergeToast: () => null }))
vi.mock('../components/MergeHighlight.js', () => ({ MergeHighlight: () => null }))
vi.mock('../components/HeaderBranchBanner.js', () => ({ HeaderBranchBanner: () => null }))

const { default: CanvasPage } = await import('./CanvasPage.js')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

afterEach(() => {
  vi.unstubAllGlobals()
  cleanup()
  vi.clearAllMocks()
})

describe('CanvasPage navigation abort (real browser)', () => {
  it('aborts the in-flight canvases fetch with a real browser AbortSignal on unmount', async () => {
    // Capture the real AbortSignal handed to the canvases request and keep the
    // request in flight. Real browser AbortSignal/fetch semantics — not a
    // jsdom polyfill — exercise the unmount→abort path the back button hits.
    let canvasesSignal: AbortSignal | undefined
    const realFetch = window.fetch.bind(window)
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('/canvases')) {
          canvasesSignal = init?.signal ?? undefined
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('The user aborted a request.', 'AbortError')),
            )
          })
        }
        if (url.includes('/api/')) {
          return new Promise<Response>(() => {})
        }
        return realFetch(input, init)
      }),
    )

    const { unmount } = render(
      <MemoryRouter initialEntries={['/canvas/sess_1/canvas-a']}>
        <Routes>
          <Route path="/canvas/:workspaceId/*" element={<CanvasPage />} />
        </Routes>
      </MemoryRouter>,
    )

    await sleep(50)

    expect(
      canvasesSignal,
      'canvases fetch must receive a real AbortSignal so the back button can cancel it',
    ).toBeInstanceOf(AbortSignal)
    expect(canvasesSignal?.aborted, 'signal must not be aborted while mounted').toBe(false)

    // Navigate away (browser back / route change tears the page down).
    unmount()
    await sleep(10)

    expect(
      canvasesSignal?.aborted,
      'unmounting CanvasPage must abort the in-flight canvases fetch',
    ).toBe(true)
  })
})
