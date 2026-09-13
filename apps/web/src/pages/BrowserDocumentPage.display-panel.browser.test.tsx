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

function render(ui: ReactElement) {
  return rtlRender(
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </div>,
  )
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
  render(<BrowserDocumentPage store={store.index} pointer={store.pointer} clock={store.clock} />)
  await screen.findByTestId('mock-spatial-editor', undefined, { timeout: 15_000 })
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
