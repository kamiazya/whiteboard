// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import type { WorkspaceDocumentEntry } from './document-entry.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

// The open wayfinding contract (2026-09-05 redesign decision):
// - coarse pointer (touch): a tap on a document card OPENS it — no
//   select-then-Open round trip — and the preview column does not render.
//   Long-press is the object-action path (the sheet menu), finally giving
//   Pin a touch route.
// - fine pointer (desktop): click still selects into the preview pane;
//   double-click opens; Enter opens (one activation for keyboard users);
//   Space keeps the native button click, i.e. select-and-preview.

afterEach(cleanup)

const entries = [
  { documentId: 'd1', path: 'meeting-notes', name: 'Meeting notes', kind: 'markdown' as const },
  { documentId: 'd2', path: 'plans/roadmap', name: 'Roadmap', kind: 'spatial' as const },
]

const realMatchMedia = window.matchMedia
let coarse = false
const stubMql = (matches: boolean, media: string) =>
  ({
    matches,
    media,
    addEventListener: () => {},
    removeEventListener: () => {},
  }) as unknown as MediaQueryList
beforeEach(() => {
  coarse = false
  window.matchMedia = (query: string) =>
    query === '(pointer: coarse)'
      ? stubMql(coarse, query)
      : realMatchMedia
        ? realMatchMedia.call(window, query)
        : stubMql(false, query)
})
afterEach(() => {
  window.matchMedia = realMatchMedia
})

function renderPanel(
  overrides: {
    onOpenDocument?: (path: string) => void
    setPinned?: (entry: { readonly path: string }, pinned: boolean) => Promise<void>
    rows?: readonly WorkspaceDocumentEntry[]
  } = {},
) {
  const { setPinned, rows, ...panelProps } = overrides
  const source = fakeFilesSource({
    listDocuments: () => Promise.resolve(rows ?? entries),
    ...(setPinned === undefined ? {} : { setPinned }),
  })
  render(<WorkspaceFilesPanel source={source} {...panelProps} />)
  return source
}

async function cardButton(title: string) {
  await waitFor(() => {
    expect(screen.getAllByTestId('card-title').some((el) => el.textContent === title)).toBe(true)
  })
  const el = screen.getAllByTestId('card-title').find((n) => n.textContent === title)
  return el?.closest('button') as HTMLElement
}

describe('coarse pointer: tap opens', () => {
  it('a tap on a document card opens it and the preview column is gone', async () => {
    coarse = true
    const onOpenDocument = vi.fn()
    renderPanel({ onOpenDocument })

    const card = await cardButton('Meeting notes')
    // The preview column must not render at all on touch: it stacked below
    // the grid and held the only Open button, which is the 2-tap bug.
    expect(screen.queryByText('Select a document to preview its content.')).toBeNull()

    fireEvent.click(card, { detail: 1 })
    expect(onOpenDocument).toHaveBeenCalledWith('meeting-notes')
  })

  it('with no open handler the tap still selects and the preview stays', async () => {
    // A read-only host (no onOpenDocument) has nothing to open into;
    // looking must keep working, so the preview column survives.
    coarse = true
    renderPanel()

    const card = await cardButton('Meeting notes')
    expect(screen.getByText('Select a document to preview its content.')).toBeTruthy()
    fireEvent.click(card, { detail: 1 })
    expect(await screen.findByTestId('okf-preview')).toBeTruthy()
  })

  it('a long-press on a card opens the sheet menu and does not open the document', async () => {
    coarse = true
    const onOpenDocument = vi.fn()
    const setPinned = vi.fn(async () => {})
    renderPanel({ onOpenDocument, setPinned })

    const card = await cardButton('Meeting notes')
    fireEvent.pointerDown(card, { pointerType: 'touch', clientX: 40, clientY: 40, pointerId: 7 })
    const menu = await screen.findByRole('menu', { name: 'Document actions' })
    // Pin's first touch-reachable path: it used to live only behind
    // right-click, which a finger cannot perform.
    expect(within(menu).getByRole('menuitem', { name: 'Pin' })).toBeTruthy()

    // The release of the long-press must not read as a tap-to-open.
    fireEvent.pointerUp(card, { pointerType: 'touch', pointerId: 7 })
    fireEvent.click(card, { detail: 1 })
    expect(onOpenDocument).not.toHaveBeenCalled()
  })

  it('a short tap does not open the menu', async () => {
    coarse = true
    const onOpenDocument = vi.fn()
    renderPanel({ onOpenDocument })

    const card = await cardButton('Meeting notes')
    fireEvent.pointerDown(card, { pointerType: 'touch', clientX: 40, clientY: 40, pointerId: 7 })
    fireEvent.pointerUp(card, { pointerType: 'touch', pointerId: 7 })
    fireEvent.click(card, { detail: 1 })
    expect(screen.queryByRole('menu', { name: 'Document actions' })).toBeNull()
    expect(onOpenDocument).toHaveBeenCalledWith('meeting-notes')
  })

  it('a tap on a search result opens it', async () => {
    coarse = true
    const onOpenDocument = vi.fn()
    renderPanel({ onOpenDocument })
    await cardButton('Meeting notes')

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search documents' }), {
      target: { value: 'Roadmap' },
    })
    const results = await screen.findByTestId('search-results')
    await waitFor(() => {
      expect(within(results).getAllByTestId('result-title').length).toBeGreaterThan(0)
    })
    const hit = within(results)
      .getAllByTestId('result-title')
      .find((el) => el.textContent?.includes('Roadmap'))
    fireEvent.click(hit?.closest('button') as HTMLElement, { detail: 1 })
    expect(onOpenDocument).toHaveBeenCalledWith('plans/roadmap')
  })
})

describe('fine pointer: click previews, double-click and Enter open', () => {
  it('click selects into the preview and does not open', async () => {
    const onOpenDocument = vi.fn()
    renderPanel({ onOpenDocument })

    const card = await cardButton('Meeting notes')
    fireEvent.click(card, { detail: 1 })
    expect(onOpenDocument).not.toHaveBeenCalled()
    expect(await screen.findByTestId('okf-preview')).toBeTruthy()
  })

  it('double-click opens', async () => {
    const onOpenDocument = vi.fn()
    renderPanel({ onOpenDocument })

    const card = await cardButton('Meeting notes')
    fireEvent.doubleClick(card)
    expect(onOpenDocument).toHaveBeenCalledWith('meeting-notes')
  })

  it('Enter on a focused card opens in one activation', async () => {
    const onOpenDocument = vi.fn()
    renderPanel({ onOpenDocument })

    const card = await cardButton('Meeting notes')
    card.focus()
    fireEvent.keyDown(card, { key: 'Enter' })
    expect(onOpenDocument).toHaveBeenCalledWith('meeting-notes')
  })

  it('Enter opens from the one-column tree too', async () => {
    localStorage.setItem('whiteboard.document-browser.columns.v1', 'one')
    try {
      const onOpenDocument = vi.fn()
      renderPanel({ onOpenDocument })

      const row = await screen.findByRole('treeitem', { name: /Meeting notes/ })
      const button = within(row).getByRole('button', { name: /Meeting notes/ })
      fireEvent.keyDown(button, { key: 'Enter' })
      expect(onOpenDocument).toHaveBeenCalledWith('meeting-notes')
    } finally {
      localStorage.removeItem('whiteboard.document-browser.columns.v1')
    }
  })
})
