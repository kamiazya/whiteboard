import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import '../index.css'

// Stub Excalidraw so the page mounts without the real editor.
const fakeApi = {
  updateLibrary: vi.fn(),
  getSceneElements: () => [],
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

// Stub fetch so library/canvases API calls do not fail loudly.
beforeEach(() => {
  // Reset the URL hash so each test starts from a clean slate.
  // syncFullscreenHash may write #fullscreen during a previous test;
  // leaving it set would cause detectInitialFullscreen to return true
  // unexpectedly and make subsequent tests start in fullscreen.
  window.location.hash = ''
  vi.stubGlobal(
    'fetch',
    vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ canvases: [], urls: [] }), { status: 200 })),
    ),
  )
})

afterEach(() => {
  window.location.hash = ''
  vi.unstubAllGlobals()
  cleanup()
  vi.clearAllMocks()
})

const { default: CanvasPage } = await import('./CanvasPage.js')

const BASE_PATH = '/canvas/sess_1/canvas-a'
const EXIT_FULLSCREEN_TITLE = 'Exit fullscreen (Esc / f)'

function renderCanvasPage(initialEntry: string = BASE_PATH) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/canvas/:workspaceId/*" element={<CanvasPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

// The "Exit fullscreen" button is only rendered while fullscreen is active,
// so its presence is the observable signal for the fullscreen state.
function queryExitFullscreenButton(): HTMLElement | null {
  return screen.queryByTitle(EXIT_FULLSCREEN_TITLE)
}

function getExitFullscreenButton(): HTMLElement {
  return screen.getByTitle(EXIT_FULLSCREEN_TITLE)
}

// Find replaceState calls whose target URL (3rd arg) matches a predicate.
function replaceStateUrls(
  replaceState: ReturnType<typeof vi.spyOn>,
  predicate: (url: string) => boolean,
): unknown[][] {
  return replaceState.mock.calls.filter((call: unknown[]) => {
    const url = call[2]
    return typeof url === 'string' && predicate(url)
  })
}

describe('CanvasPage fullscreen URL/state synchronization (real browser)', () => {
  describe('initial state from URL', () => {
    it('starts in normal mode when no fullscreen indicator is in the URL', () => {
      renderCanvasPage(BASE_PATH)
      expect(queryExitFullscreenButton()).toBeNull()
    })

    it('starts in fullscreen mode when #fullscreen hash is present', () => {
      // MemoryRouter does not drive window.location, so set the hash directly.
      window.location.hash = '#fullscreen'
      try {
        renderCanvasPage(`${BASE_PATH}#fullscreen`)
        expect(getExitFullscreenButton()).toBeTruthy()
      } finally {
        window.location.hash = ''
      }
    })

    it('starts in fullscreen mode when legacy ?fullscreen=1 query param is present', () => {
      renderCanvasPage(`${BASE_PATH}?fullscreen=1`)
      expect(getExitFullscreenButton()).toBeTruthy()
    })
  })

  describe('history.replaceState sync on toggle', () => {
    it('writes #fullscreen to the URL when entering fullscreen via the in-page button', async () => {
      const replaceState = vi.spyOn(window.history, 'replaceState')
      window.location.hash = ''

      renderCanvasPage(BASE_PATH)

      fireEvent.keyDown(window, { key: 'f' })

      const fullscreenCalls = replaceStateUrls(replaceState, (url) => url.endsWith('#fullscreen'))
      expect(
        fullscreenCalls.length,
        'replaceState should be called with a #fullscreen URL',
      ).toBeGreaterThan(0)

      replaceState.mockRestore()
    })

    it('removes #fullscreen from the URL when exiting fullscreen via the Exit button', async () => {
      window.location.hash = '#fullscreen'
      const replaceState = vi.spyOn(window.history, 'replaceState')

      try {
        renderCanvasPage(`${BASE_PATH}#fullscreen`)

        fireEvent.click(getExitFullscreenButton())

        const clearCalls = replaceStateUrls(replaceState, (url) => !url.endsWith('#fullscreen'))
        expect(
          clearCalls.length,
          'replaceState must be called without #fullscreen after exiting',
        ).toBeGreaterThan(0)
      } finally {
        window.location.hash = ''
        replaceState.mockRestore()
      }
    })

    it('does not clobber a non-fullscreen hash (e.g. #addLibrary=…) when not in fullscreen', () => {
      window.location.hash = '#addLibrary=https://example.com/lib.json'
      const replaceState = vi.spyOn(window.history, 'replaceState')

      try {
        renderCanvasPage(`${BASE_PATH}#addLibrary=https://example.com/lib.json`)

        // The fullscreen sync must never call replaceState when the page is not in
        // fullscreen. Any replaceState call that strips #addLibrary without adding
        // #fullscreen would indicate the sync incorrectly clobbered the hash.
        // Acceptable calls: none, or #fullscreen (if something else triggered it).
        // Unacceptable: a URL that lacks both #addLibrary and #fullscreen (a bare
        // pathname rewrite that silently wiped the existing hash).
        const illegalCalls = replaceStateUrls(
          replaceState,
          (url) => !url.endsWith('#fullscreen') && !url.includes('#addLibrary'),
        )
        expect(
          illegalCalls.length,
          'fullscreen sync must not strip #addLibrary when not in fullscreen',
        ).toBe(0)
      } finally {
        window.location.hash = ''
        replaceState.mockRestore()
      }
    })
  })

  describe('hashchange event handler', () => {
    it('enters fullscreen when a hashchange event delivers #fullscreen', async () => {
      renderCanvasPage(BASE_PATH)

      expect(queryExitFullscreenButton()).toBeNull()

      // Dispatch an explicit hashchange so the test does not rely on the timing
      // of the native event the assignment fires.
      await act(async () => {
        window.location.hash = '#fullscreen'
        window.dispatchEvent(new HashChangeEvent('hashchange'))
      })

      await waitFor(() => {
        expect(getExitFullscreenButton()).toBeTruthy()
      })

      window.location.hash = ''
    })

    it('exits fullscreen when a hashchange event removes #fullscreen', async () => {
      window.location.hash = '#fullscreen'

      try {
        renderCanvasPage(`${BASE_PATH}#fullscreen`)

        await waitFor(() => {
          expect(getExitFullscreenButton()).toBeTruthy()
        })

        await act(async () => {
          window.location.hash = ''
          window.dispatchEvent(new HashChangeEvent('hashchange'))
        })

        await waitFor(() => {
          expect(queryExitFullscreenButton()).toBeNull()
        })
      } finally {
        window.location.hash = ''
      }
    })

    it('removes the hashchange listener on unmount', () => {
      const addSpy = vi.spyOn(window, 'addEventListener')
      const removeSpy = vi.spyOn(window, 'removeEventListener')

      const { unmount } = renderCanvasPage(BASE_PATH)

      // Capture the exact handler reference that was registered for 'hashchange'.
      const hashchangeHandler = addSpy.mock.calls
        .filter((call) => call[0] === 'hashchange')
        .map((call) => call[1])
        .at(-1)

      unmount()

      const removedHandlers = removeSpy.mock.calls
        .filter((call) => call[0] === 'hashchange')
        .map((call) => call[1])

      expect(hashchangeHandler, 'a hashchange handler must have been registered').toBeDefined()
      expect(
        removedHandlers,
        'the registered hashchange handler must be removed on unmount',
      ).toContain(hashchangeHandler)

      addSpy.mockRestore()
      removeSpy.mockRestore()
    })
  })

  describe('keyboard shortcuts', () => {
    it('toggles fullscreen on when pressing "f"', () => {
      renderCanvasPage(BASE_PATH)
      expect(queryExitFullscreenButton()).toBeNull()

      fireEvent.keyDown(window, { key: 'f' })

      expect(getExitFullscreenButton()).toBeTruthy()
    })

    it('toggles fullscreen off when pressing "f" again', async () => {
      renderCanvasPage(BASE_PATH)

      await act(async () => {
        fireEvent.keyDown(window, { key: 'f' })
      })
      await waitFor(() => {
        expect(getExitFullscreenButton()).toBeTruthy()
      })

      await act(async () => {
        fireEvent.keyDown(window, { key: 'f' })
      })
      await waitFor(() => {
        expect(queryExitFullscreenButton()).toBeNull()
      })
    })

    it('exits fullscreen when pressing Escape', () => {
      window.location.hash = '#fullscreen'

      try {
        renderCanvasPage(`${BASE_PATH}#fullscreen`)
        expect(getExitFullscreenButton()).toBeTruthy()

        fireEvent.keyDown(window, { key: 'Escape' })

        expect(queryExitFullscreenButton()).toBeNull()
      } finally {
        window.location.hash = ''
      }
    })

    it('does not toggle fullscreen when typing "f" in an input field', () => {
      renderCanvasPage(BASE_PATH)

      const input = document.createElement('input')
      document.body.appendChild(input)

      fireEvent.keyDown(input, { key: 'f', target: input })

      expect(queryExitFullscreenButton()).toBeNull()

      document.body.removeChild(input)
    })

    it('does not toggle fullscreen when typing "f" in a textarea', () => {
      renderCanvasPage(BASE_PATH)

      const textarea = document.createElement('textarea')
      document.body.appendChild(textarea)

      fireEvent.keyDown(textarea, { key: 'f', target: textarea })

      expect(queryExitFullscreenButton()).toBeNull()

      document.body.removeChild(textarea)
    })

    it('does not toggle fullscreen when typing "f" in a contenteditable element', () => {
      renderCanvasPage(BASE_PATH)

      const div = document.createElement('div')
      div.contentEditable = 'true'
      document.body.appendChild(div)

      fireEvent.keyDown(div, { key: 'f', target: div })

      expect(queryExitFullscreenButton()).toBeNull()

      document.body.removeChild(div)
    })

    it('does not toggle fullscreen when "f" is pressed with metaKey', () => {
      renderCanvasPage(BASE_PATH)
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      expect(queryExitFullscreenButton()).toBeNull()
    })

    it('does not toggle fullscreen when "f" is pressed with ctrlKey', () => {
      renderCanvasPage(BASE_PATH)
      fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
      expect(queryExitFullscreenButton()).toBeNull()
    })

    it('does not toggle fullscreen when "f" is pressed with altKey', () => {
      renderCanvasPage(BASE_PATH)
      fireEvent.keyDown(window, { key: 'f', altKey: true })
      expect(queryExitFullscreenButton()).toBeNull()
    })

    it('pressing Escape in normal mode (not fullscreen) is a no-op', () => {
      renderCanvasPage(BASE_PATH)
      // Sanity: not in fullscreen to start.
      expect(queryExitFullscreenButton()).toBeNull()

      fireEvent.keyDown(window, { key: 'Escape' })

      // Still not in fullscreen — Escape outside fullscreen must not enter it.
      expect(queryExitFullscreenButton()).toBeNull()
    })

    it('removes the keydown listener on unmount', () => {
      const addSpy = vi.spyOn(window, 'addEventListener')
      const removeSpy = vi.spyOn(window, 'removeEventListener')

      const { unmount } = renderCanvasPage(BASE_PATH)

      // Capture the exact handler reference that was registered for 'keydown'.
      const keydownHandler = addSpy.mock.calls
        .filter((call) => call[0] === 'keydown')
        .map((call) => call[1])
        .at(-1)

      unmount()

      // The same handler must have been passed to removeEventListener.
      const removedHandlers = removeSpy.mock.calls
        .filter((call) => call[0] === 'keydown')
        .map((call) => call[1])

      expect(keydownHandler, 'a keydown handler must have been registered').toBeDefined()
      expect(
        removedHandlers,
        'the registered keydown handler must be removed on unmount',
      ).toContain(keydownHandler)

      addSpy.mockRestore()
      removeSpy.mockRestore()
    })

    it('removes ALL keydown listeners registered during fullscreen toggling on unmount', async () => {
      // The keydown effect has [isFullscreen] as its dependency, so React
      // tears down and re-registers the handler on every fullscreen toggle.
      // This test exercises the re-render → unmount path to ensure no
      // intermediate handler leaks when the component is destroyed mid-cycle.
      const addSpy = vi.spyOn(window, 'addEventListener')
      const removeSpy = vi.spyOn(window, 'removeEventListener')

      const { unmount } = renderCanvasPage(BASE_PATH)

      // Toggle fullscreen — triggers a state change that causes React to
      // run the cleanup of the current effect and re-register the handler.
      await act(async () => {
        fireEvent.keyDown(window, { key: 'f' })
      })
      await waitFor(() => {
        expect(getExitFullscreenButton()).toBeTruthy()
      })

      // Collect every 'keydown' handler registered since the spy was installed.
      const addedHandlers = addSpy.mock.calls
        .filter((call) => call[0] === 'keydown')
        .map((call) => call[1])

      unmount()

      const removedHandlers = removeSpy.mock.calls
        .filter((call) => call[0] === 'keydown')
        .map((call) => call[1])

      expect(
        addedHandlers.length,
        'at least two keydown handlers must have been registered (initial + post-toggle)',
      ).toBeGreaterThanOrEqual(2)
      for (const handler of addedHandlers) {
        expect(
          removedHandlers,
          'every registered keydown handler must be removed on unmount — no stale listeners after toggle',
        ).toContain(handler)
      }

      addSpy.mockRestore()
      removeSpy.mockRestore()
    })
  })

  describe('legacy ?fullscreen=1 normalization', () => {
    it('activates fullscreen from ?fullscreen=1 and syncs to #fullscreen in the URL', () => {
      const replaceState = vi.spyOn(window.history, 'replaceState')

      renderCanvasPage(`${BASE_PATH}?fullscreen=1`)

      // detectInitialFullscreen → isFullscreen=true → syncFullscreenHash writes #fullscreen.
      const fullscreenCalls = replaceStateUrls(replaceState, (url) => url.endsWith('#fullscreen'))
      expect(
        fullscreenCalls.length,
        'legacy ?fullscreen=1 should trigger a replaceState to #fullscreen',
      ).toBeGreaterThan(0)

      replaceState.mockRestore()
    })
  })
})
