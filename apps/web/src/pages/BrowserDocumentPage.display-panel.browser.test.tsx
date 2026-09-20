/**
 * The canvas display settings, as one of the panels beside the editor.
 *
 * They used to be a POPOVER hung off the ⋯ kebab, and on a phone that has no
 * way out: Radix dismisses a popover on an outside click or Escape, a phone
 * has no Escape, and the panel measured 424px wide against a 390px screen —
 * so there was barely an outside left to press. Measured before this: eight
 * controls (Curved, On, ⭐, 📌, Neon, Preview neon …) sat past the screen's
 * right edge, and the panel carried no close control of its own.
 *
 * A real browser, and the viewport rather than a narrow container: the sheet
 * shape and its close control are `md:` rules, which read the viewport.
 */
import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import { LocalStoreDouble } from '../test-utils/local-index.js'
import '../index.css'
import { setViewport } from '../test-utils/viewport.js'

vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: () => <div data-testid="mock-spatial-editor" style={{ height: '100%' }} />,
}))

vi.mock('../lib/browser-backend.js', async () => {
  const { FakeBrowserBackend } = await import('../test-utils/fake-browser-backend.js')
  return { BrowserBackend: FakeBrowserBackend }
})

const { BrowserDocumentPage } = await import('./BrowserDocumentPage.js')

function wrap(ui: ReactElement) {
  return (
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </div>
  )
}

function render(ui: ReactElement) {
  return rtlRender(wrap(ui))
}

const snap: DocumentSnapshot = {
  documentId: '0W16BGNTZ49EKRX27CHPV05AFM',
  workspaceId: 'local',
  path: 'notes/board',
  name: 'Board',
  updatedAt: '2026-09-03T00:00:00.000Z',
  kind: 'spatial' as const,
}

/** The viewport is GLOBAL, so each test states the width it means. */
beforeEach(async () => {
  await setViewport(390, 780)
})

afterEach(cleanup)

async function mountLoaded() {
  const store = new LocalStoreDouble()
  await store.setDefaultDocumentId(snap.documentId)
  await store.save(snap)
  const page = () => (
    <BrowserDocumentPage store={store.index} pointer={store.pointer} clock={store.clock} />
  )
  const { rerender } = render(page())
  await screen.findByTestId('mock-spatial-editor', undefined, { timeout: 15_000 })
  /**
   * Re-renders the page around whatever is open, without touching it.
   *
   * A FRESH element each time, through the SAME wrapper. Both halves are
   * load-bearing and both were got wrong first: re-rendering the bare element
   * drops the router and the page's own `useLocation` throws, and re-rendering
   * the IDENTICAL element makes React bail out of the subtree entirely — which
   * left this test passing against a deliberately broken page, the only
   * evidence being that its mutation check could not fail it.
   */
  return () => rerender(wrap(page()))
}

it('opens display settings beside the editor, closable from inside', async () => {
  await mountLoaded()
  expect(screen.queryByTestId('display-panel')).toBeNull()

  await userEvent.click(await screen.findByRole('button', { name: /^display$/i }))
  const panel = await screen.findByTestId('display-panel', undefined, { timeout: 15_000 })
  expect(panel).toBeInTheDocument()

  // The whole point: a way out that lives IN the panel, not off its edge.
  await userEvent.click(await screen.findByRole('button', { name: /close display/i }))
  await waitFor(() => expect(screen.queryByTestId('display-panel')).toBeNull(), { timeout: 15_000 })
})

it('holds the one slot, so comments cannot stay open beside it', async () => {
  await mountLoaded()
  await userEvent.click(await screen.findByRole('button', { name: /^display$/i }))
  await screen.findByTestId('display-panel', undefined, { timeout: 15_000 })

  await userEvent.click(await screen.findByRole('button', { name: /^comments/i }))
  await waitFor(() => expect(screen.queryByTestId('display-panel')).toBeNull(), { timeout: 15_000 })
  expect(screen.getByTestId('comments-rail')).toBeInTheDocument()
})

it('keeps every display control inside a phone-width screen', async () => {
  await mountLoaded()
  await userEvent.click(await screen.findByRole('button', { name: /^display$/i }))
  const panel = await screen.findByTestId('display-panel', undefined, { timeout: 15_000 })

  // A control past the screen's edge is not merely ugly — it cannot be
  // tapped. Per-control geometry rather than the panel's own `scrollWidth`,
  // which is the probe that looks right and is not: the panel scrolls
  // vertically, so a row overflowing sideways still reports
  // `scrollWidth === clientWidth` while its options sit off-screen.
  // Mutation-checked at that shape — the routing row without its
  // `flex-wrap` and with unshrinkable options measured Orthogonal at
  // 269..469 and Curved at 471..671 against a 390px screen, and this
  // catches both. Reported BY NAME so a failure names what escaped.
  const escaping = [...panel.querySelectorAll('button, input, select, label')]
    .map((el) => ({
      name: el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '?',
      box: el.getBoundingClientRect(),
    }))
    .filter(({ box }) => box.width > 0 && (box.right > 390.5 || box.left < -0.5))
    .map(({ name, box }) => `${name}@${Math.round(box.left)}..${Math.round(box.right)}`)
  expect(escaping).toEqual([])
})

it('keeps the open panel mounted when the page around it re-renders', async () => {
  const rerenderPage = await mountLoaded()
  await userEvent.click(await screen.findByRole('button', { name: /^display$/i }))
  const panel = await screen.findByTestId('display-panel', undefined, { timeout: 15_000 })

  // Expanding is state this SUBTREE owns, so it is what a remount throws away.
  await userEvent.click(await screen.findByRole('button', { name: /expand display/i }))
  await screen.findByRole('button', { name: /collapse display/i }, { timeout: 15_000 })

  rerenderPage()

  // The SAME DOM node, not an equal one, and still expanded. `DocumentPage`
  // picks the panel out of a `Record<InspectorKind, () => ReactNode>` and
  // CALLS it, so the element's type is the module-level component and React
  // reconciles in place. Rendering the entry instead — `<Panel />` where
  // `Panel` is a value read from that record — would make a new component
  // type on every render, so React would unmount this subtree and build a
  // fresh one: this node would be detached and the expansion would be gone.
  // SonarQube reads the record's entries as nested component definitions
  // (S6478) for exactly that reason; this is the measurement that says which
  // of the two shapes the file has.
  await waitFor(
    () => {
      expect(panel.isConnected).toBe(true)
      expect(screen.getByTestId('display-panel')).toBe(panel)
      expect(screen.queryByRole('button', { name: /collapse display/i })).not.toBeNull()
    },
    { timeout: 15_000 },
  )
})
