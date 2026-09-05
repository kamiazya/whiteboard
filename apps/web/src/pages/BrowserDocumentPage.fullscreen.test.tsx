// Fullscreen means the DOCUMENT, maximised. The top bar rode along into the
// top layer — the way back, the title, its menus — which is 48px of chrome
// nobody entered fullscreen to see. It steps aside, leaving the editor and
// the dock. The control and the way back out are the SHELL's
// (AppShell.fullscreen.test.tsx); this page carries neither.
// jsdom has no IndexedDB, and the page's backend reads content from a real
// one. Without this every content read fails — which the page now reports as
// an unreadable document instead of silently drawing an editor over it, so a
// suite about fullscreen chrome would otherwise be testing the error screen.
import 'fake-indexeddb/auto'
import { act, cleanup, render as rtlRender, screen } from '@testing-library/react'
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
    setFullscreenElement(document.documentElement)
  })
  // The chrome steps aside — the document is what fullscreen is FOR.
  expect(screen.queryByRole('button', { name: 'Back to documents' })).toBeNull()

  await act(async () => {
    setFullscreenElement(null)
  })
  await screen.findByRole('button', { name: 'Back to documents' })
})

it('carries no fullscreen control of its own: the shell owns the toggle and the way out', async () => {
  await renderLoaded()
  expect(screen.queryByRole('button', { name: 'Fullscreen' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'View options' })).toBeNull()
  await act(async () => {
    setFullscreenElement(document.documentElement)
  })
  expect(screen.queryByRole('button', { name: 'Exit fullscreen' })).toBeNull()
})

it('starts OUT of fullscreen under jsdom, where fullscreenElement is undefined', async () => {
  // The regression this pins: the sync compared `!== null`, jsdom's default
  // is UNDEFINED, and `undefined !== null` read as "in fullscreen" — so every
  // first mount hid the top bar. Delete the test override to expose the real
  // jsdom default rather than the null this file installs elsewhere.
  delete (document as { fullscreenElement?: Element | null }).fullscreenElement
  await renderLoaded()
})
