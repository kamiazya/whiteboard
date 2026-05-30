// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Stub Excalidraw but invoke the excalidrawAPI callback so CanvasPage's
// apiRef becomes ready — the library-import effect polls apiRef before
// firing its fetches, so without this the libraries fetch never runs.
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
vi.mock('@excalidraw/excalidraw/index.css', () => ({}))

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

vi.mock('../components/WorkspaceTopBar.js', () => ({ default: () => null }))
vi.mock('../components/MergeToast.js', () => ({ MergeToast: () => null }))
vi.mock('../components/MergeHighlight.js', () => ({ MergeHighlight: () => null }))
vi.mock('../components/HeaderBranchBanner.js', () => ({ HeaderBranchBanner: () => null }))

const mockApiFetch = vi.fn()
vi.mock('../lib/api-client.js', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

const { default: CanvasPage } = await import('./CanvasPage.js')

function renderCanvasPage() {
  return render(
    <MemoryRouter initialEntries={['/canvas/sess_1/canvas-a']}>
      <Routes>
        <Route path="/canvas/:workspaceId/*" element={<CanvasPage /> as ReactNode} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  mockApiFetch.mockImplementation(() => new Promise(() => {})) // never resolves
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('CanvasPage fetch abort on unmount', () => {
  it('passes AbortSignal to the canvases fetch', async () => {
    const capturedInits: (RequestInit | undefined)[] = []
    mockApiFetch.mockImplementation((_url: unknown, init?: RequestInit) => {
      capturedInits.push(init)
      return new Promise(() => {})
    })

    renderCanvasPage()
    // Allow useEffects to fire
    await act(async () => {})

    const canvasesFetch = capturedInits.find((_, i) => {
      const url = (mockApiFetch.mock.calls[i]?.[0] as string) ?? ''
      return url.includes('/canvases')
    })
    expect(
      canvasesFetch?.signal,
      'canvases useEffect must pass signal to apiFetch so it can be aborted on unmount',
    ).toBeInstanceOf(AbortSignal)
  })

  it('aborts the in-flight canvases fetch when the component unmounts', async () => {
    let aborted = false
    mockApiFetch.mockImplementation((_url: unknown, init?: RequestInit) => {
      const url = _url as string
      if (url.includes('/canvases')) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true
            reject(new DOMException('Aborted', 'AbortError'))
          })
        })
      }
      return new Promise(() => {})
    })

    const { unmount } = renderCanvasPage()
    await act(async () => {})

    act(() => { unmount() })

    expect(aborted, 'canvases fetch must be aborted when the component unmounts').toBe(true)
  })

  it('passes AbortSignal to the libraries fetch', async () => {
    const capturedByUrl: Record<string, RequestInit | undefined> = {}
    mockApiFetch.mockImplementation((url: unknown, init?: RequestInit) => {
      capturedByUrl[url as string] = init
      return new Promise(() => {})
    })

    renderCanvasPage()
    await act(async () => {})

    const libUrl = Object.keys(capturedByUrl).find((u) => u.includes('/libraries'))
    expect(
      libUrl,
      'libraries fetch must be called',
    ).toBeTruthy()
    expect(
      capturedByUrl[libUrl!]?.signal,
      'libraries useEffect must pass signal to apiFetch so it can be aborted on unmount',
    ).toBeInstanceOf(AbortSignal)
  })

  it('aborts an in-flight auto-version thumbnail upload on unmount', async () => {
    let thumbnailAborted = false
    mockApiFetch.mockImplementation((url: unknown, init?: RequestInit) => {
      if ((url as string).includes('/thumbnail')) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            thumbnailAborted = true
            reject(new DOMException('Aborted', 'AbortError'))
          })
        })
      }
      return new Promise(() => {})
    })

    const { unmount } = renderCanvasPage()
    await act(async () => {})

    // Fire the websocket callback for an auto-saved version while mounted,
    // leaving the thumbnail PUT in-flight (do NOT await — it never resolves
    // until aborted). Flush microtasks so the PUT is actually dispatched.
    act(() => {
      void captured.options.onVersionCreated?.({ id: 'v1', auto: true })
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    act(() => { unmount() })
    await act(async () => {})

    expect(
      thumbnailAborted,
      'thumbnail PUT must carry an AbortSignal that fires on unmount',
    ).toBe(true)
  })
})
