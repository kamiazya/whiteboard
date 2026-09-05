/**
 * REAL element fullscreen — enter via a real activated click, exit via the
 * floating control — against the browser's own fullscreenchange and
 * document.fullscreenElement. The jsdom fullscreen suite models the
 * capability with stubs (rejection and no-API branches it can state
 * honestly); what it cannot state is that the browser grants the request,
 * fires the event, and that focus hand-off survives the real top-layer
 * transitions. Focus-restore is the class behind three root-caused flakes,
 * so it is pinned here against the real thing.
 */
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { act, cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import {
  getBrowserWorkspaceId,
  setBrowserWorkspaceIdForTests,
} from '../lib/browser-workspace-id.js'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import { LocalStoreDouble } from '../test-utils/local-index.js'
import { BrowserDocumentPage } from './BrowserDocumentPage.js'
import '../index.css'

// No real IndexedDB in this file (`LocalStoreDouble` is in-memory), so
// nothing else in this page's module graph resolves the workspace-id
// accessor the way `claimIsolatedWhiteboardDb` would for a real-DB file.
setBrowserWorkspaceIdForTests(generateDocumentId())

afterEach(async () => {
  // The narrow-width test below shadows this accessor; drop the stub before
  // asking the real one, or teardown calls exitFullscreen on a document that
  // was never in it ("Document not active").
  delete (document as { fullscreenElement?: Element | null }).fullscreenElement
  if (document.fullscreenElement !== null) {
    await document.exitFullscreen()
  }
  cleanup()
  await page.viewport(1280, 900)
})

function render(ui: ReactElement) {
  return rtlRender(
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </div>,
  )
}

const snap: DocumentSnapshot = {
  documentId: '0PV05AFMSY38DJQW16BGNTZ49E',
  workspaceId: getBrowserWorkspaceId(),
  path: 'canvas-a',
  name: 'Canvas A',
  kind: 'spatial',
  updatedAt: '2026-04-23T00:00:00Z',
}

async function renderLoaded() {
  const store = new LocalStoreDouble()
  await store.setDefaultDocumentId('0PV05AFMSY38DJQW16BGNTZ49E')
  await store.save(snap)
  await act(async () => {
    render(<BrowserDocumentPage store={store.index} pointer={store.pointer} clock={store.clock} />)
  })
  await screen.findByRole('button', { name: 'Back to documents' }, { timeout: 10_000 })
}

it('really enters fullscreen on click, focuses the exit control, and restores focus on exit', async () => {
  await renderLoaded()

  // A real click carries the user activation requestFullscreen requires.
  await userEvent.click(screen.getByRole('button', { name: 'Fullscreen' }))
  await waitFor(() => expect(document.fullscreenElement).not.toBeNull(), { timeout: 10_000 })

  // The chrome steps aside; the one way back out holds focus.
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Back to documents' })).toBeNull(),
  )
  const exit = await screen.findByRole('button', { name: 'Exit fullscreen' })
  await waitFor(() => expect(document.activeElement).toBe(exit))

  await userEvent.click(exit)
  await waitFor(() => expect(document.fullscreenElement).toBeNull(), { timeout: 10_000 })

  // The chrome returns, and focus lands back on the toggle that started it.
  await screen.findByRole('button', { name: 'Back to documents' })
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Fullscreen' })),
  )
})

// Where a camera can be, and where it cannot. The web exposes the safe area
// as a uniform band per edge — never the cutout's position along that edge —
// so a control on the top edge either collides with a punch-hole or steps
// back from the whole band on every device that has one, however far the
// camera is from that corner. Neither is acceptable, and no API distinguishes
// them (Android's own DisplayCutout.getBoundingRects has no web counterpart).
// So the control lives on the edge no phone puts a camera on. Asserted as
// geometry against the REAL fullscreened element rather than on class names:
// the invariant is where the button ends up, not how it got there.
it('keeps the exit control off the edge a camera can occupy', async () => {
  await renderLoaded()
  await userEvent.click(screen.getByRole('button', { name: 'Fullscreen' }))
  await waitFor(() => expect(document.fullscreenElement).not.toBeNull(), { timeout: 10_000 })

  const exit = await screen.findByRole('button', { name: 'Exit fullscreen' })
  const surface = screen.getByRole('main').getBoundingClientRect()
  const control = exit.getBoundingClientRect()

  expect(control.top).toBeGreaterThan(surface.top + surface.height / 2)
  expect(control.left).toBeLessThan(surface.left + surface.width / 2)
})

// The bottom edge is the only one no camera can reach — in landscape the
// device's camera edge becomes a SIDE of the screen, never its bottom — but
// it is also where both surfaces keep their own strip: the canvas dock (a
// fixed 295px island, centred) and, on a touch markdown editor, the
// formatting bar. The dock is what collides: centred at a fixed width, its
// left edge walks toward the corner as the viewport narrows, and at 360px
// CSS — an ordinary Android portrait width — it reaches x=33 while a control
// in the corner spans 12..48.
//
// Real fullscreen is not used here: it pins the viewport to the screen, and
// the width IS the variable under test. The flag is stubbed the way the jsdom
// suite stubs it, over real CSS and real layout.
it('does not collide with the canvas dock at a phone width', async () => {
  await page.viewport(360, 780)
  await renderLoaded()

  const main = screen.getByRole('main')
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => main })
  await act(async () => {
    document.dispatchEvent(new Event('fullscreenchange'))
  })

  const exit = await screen.findByRole('button', { name: 'Exit fullscreen' })
  const dock = [...document.querySelectorAll('div')].find((el) =>
    el.className.includes('absolute bottom-[calc(0.75rem+env(safe-area-inset-bottom))]'),
  )
  expect(dock, 'the canvas dock should be on screen for this to mean anything').toBeDefined()

  const a = exit.getBoundingClientRect()
  const b = (dock as HTMLElement).getBoundingClientRect()
  const overlaps = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  expect(overlaps, `exit ${JSON.stringify(a)} vs dock ${JSON.stringify(b)}`).toBe(false)
})
