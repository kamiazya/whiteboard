// Fullscreen means the CANVAS, maximised. The top bar rode along into the
// top layer — the way back, the title, its menus — which is 48px of chrome
// nobody entered fullscreen to see. It now steps aside, leaving the canvas
// and the dock, with one floating way back out.
// jsdom has no IndexedDB, and the page's backend reads content from a real
// one. Without this every content read fails — which the page now reports as
// an unreadable document instead of silently drawing an editor over it, so a
// suite about fullscreen chrome would otherwise be testing the error screen.
import 'fake-indexeddb/auto'
import { act, cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { LocalStoreDouble } from '../test-utils/local-index.js'
import { BrowserDocumentPage } from './BrowserDocumentPage.js'
// The top bar is React.lazy in the page; loading it in the collection phase
// keeps its chunk cost out of findBy*'s 1000ms retry budget (the lazy-race
// flake shape integrator-flow.md documents).
import '../components/WorkspaceTopBar.js'

claimIsolatedWhiteboardDb('browserdocumentpage-fullscreen')

beforeEach(() => {
  // jsdom has no fullscreen at all; start each test explicitly OUT of it.
  setFullscreenElement(null)
  // …and jsdom is therefore an environment the app now HIDES the affordance
  // in (iPhone Safari is the real one — see lib/fullscreen-support.ts). These
  // tests are about what fullscreen does once available, so they present a
  // capable environment: the method has to exist before the page renders,
  // since that is when the component reads the capability.
  Element.prototype.requestFullscreen = vi.fn(() => Promise.resolve())
})

afterEach(() => {
  cleanup()
  setFullscreenElement(null)
  delete (Element.prototype as { requestFullscreen?: unknown }).requestFullscreen
  vi.restoreAllMocks()
})

function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>)
}

const snap: DocumentSnapshot = {
  documentId: '0PV05AFMSY38DJQW16BGNTZ49E',
  workspaceId: 'local',
  path: 'canvas-a',
  name: 'Canvas A',
  kind: 'spatial',
  updatedAt: '2026-04-23T00:00:00Z',
}

/** jsdom has no real fullscreen; the page only reads this and the event. */
function setFullscreenElement(el: Element | null) {
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => el,
  })
  document.dispatchEvent(new Event('fullscreenchange'))
}

async function renderLoaded() {
  const store = new LocalStoreDouble()
  await store.setDefaultDocumentId('0PV05AFMSY38DJQW16BGNTZ49E')
  await store.save(snap)
  await act(async () => {
    render(<BrowserDocumentPage store={store.index} pointer={store.pointer} clock={store.clock} />)
  })
  // The first mount in the file pays every lazy chunk's load; the default
  // 1s retry budget loses that race under a parallel suite (the documented
  // lazy-race flake shape), so this wait carries the same 10s budget the
  // other page tests use.
  await screen.findByRole('button', { name: 'Back to documents' }, { timeout: 10_000 })
}

it('hides the top bar in fullscreen and brings it back on exit', async () => {
  await renderLoaded()

  await act(async () => {
    setFullscreenElement(screen.getByRole('main'))
  })
  // The chrome steps aside — the canvas is what fullscreen is FOR.
  expect(screen.queryByRole('button', { name: 'Back to documents' })).toBeNull()

  await act(async () => {
    setFullscreenElement(null)
  })
  await screen.findByRole('button', { name: 'Back to documents' })
})

it('floats one exit control while the chrome is gone, and it exits', async () => {
  await renderLoaded()
  const exitFullscreen = vi.fn(async () => {})
  document.exitFullscreen = exitFullscreen

  // Not there in normal view — the top bar's own toggle covers that state.
  expect(screen.queryByRole('button', { name: 'Exit fullscreen' })).toBeNull()

  await act(async () => {
    setFullscreenElement(screen.getByRole('main'))
  })
  const exit = screen.getByRole('button', { name: 'Exit fullscreen' })
  // The control someone just activated unmounted with the top bar; focus must
  // land on its replacement, not fall to <body>.
  expect(document.activeElement).toBe(exit)
  exit.click()
  expect(exitFullscreen).toHaveBeenCalledTimes(1)

  // And it leaves with the mode — the top bar's own toggle takes over.
  await act(async () => {
    setFullscreenElement(null)
  })
  expect(screen.queryByRole('button', { name: 'Exit fullscreen' })).toBeNull()
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Fullscreen' })),
  )
})

it('a rejected requestFullscreen is reported, not an unhandled rejection', async () => {
  await renderLoaded()
  const rejection = new DOMException('denied', 'NotAllowedError')
  Element.prototype.requestFullscreen = vi.fn(() => Promise.reject(rejection))
  const warnings: unknown[] = []
  vi.spyOn(console, 'warn').mockImplementation((...args) => void warnings.push(args))

  screen.getByRole('button', { name: 'Fullscreen' }).click()
  // Let the rejection propagate through the catch.
  await act(async () => {
    await Promise.resolve()
  })
  expect(warnings.some((args) => JSON.stringify(args).includes('requestFullscreen'))).toBe(true)
})

it('starts OUT of fullscreen under jsdom, where fullscreenElement is undefined', async () => {
  // The regression this pins: the sync compared `!== null`, jsdom's default
  // is UNDEFINED, and `undefined !== null` read as "in fullscreen" — so every
  // first mount hid the top bar. Delete the test override to expose the real
  // jsdom default rather than the null this file installs elsewhere.
  delete (document as { fullscreenElement?: Element | null }).fullscreenElement
  await renderLoaded()
})

it('keeps the exit control clear of a display cutout', async () => {
  // Fullscreen drops the browser chrome, so this button sits at the physical
  // screen corner — under the front camera on a notched or punch-hole phone
  // (top edge in portrait, right edge in landscape). Asserted on the class
  // rather than a computed offset because `env(safe-area-inset-*)` resolves
  // to 0px on every machine that runs this suite, so the two versions are
  // numerically identical here and only the declaration tells them apart.
  await renderLoaded()
  await act(async () => {
    setFullscreenElement(screen.getByRole('main'))
  })
  const exit = screen.getByRole('button', { name: 'Exit fullscreen' })
  expect(exit.className).toContain('env(safe-area-inset-top)')
  expect(exit.className).toContain('env(safe-area-inset-right)')
})
