// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import type { WorkspaceDocumentEntry } from './document-entry.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

// OOUI: the object's actions are reachable FROM the object. Right-click a
// document card and the same verbs the preview pane offers appear at the
// cursor — no trip across the panel required.

afterEach(cleanup)

const entries = [
  { documentId: 'd1', path: 'meeting-notes', name: 'Meeting notes', kind: 'markdown' as const },
  { documentId: 'd2', path: 'plans/roadmap', name: 'Roadmap', kind: 'spatial' as const },
]

function renderPanel(
  overrides: {
    onOpenDocument?: (path: string) => void
    onDuplicateDocument?: (path: string) => void
    onRequestDelete?: (path: string, displayName: string, kind?: 'spatial' | 'markdown') => void
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

async function contextMenuOnCard(title: string) {
  await waitFor(() => {
    expect(screen.getAllByTestId('card-title').some((el) => el.textContent === title)).toBe(true)
  })
  const el = screen.getAllByTestId('card-title').find((n) => n.textContent === title)
  fireEvent.contextMenu(el?.closest('button') as HTMLElement, { clientX: 40, clientY: 40 })
  return screen.findByRole('menu', { name: 'Document actions' })
}

describe('document card context menu', () => {
  it('offers the object verbs and Open fires the open handler', async () => {
    const onOpenDocument = vi.fn()
    const onDuplicateDocument = vi.fn()
    renderPanel({ onOpenDocument, onDuplicateDocument, onRequestDelete: () => {} })

    const menu = await contextMenuOnCard('Meeting notes')
    for (const label of ['Open', 'Duplicate', 'Rename…', 'Delete']) {
      expect(within(menu).getByRole('menuitem', { name: label })).toBeTruthy()
    }
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Open' }))
    expect(onOpenDocument).toHaveBeenCalledWith('meeting-notes')
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Document actions' })).toBeNull())
  })

  it('Delete carries the kind the dialog copy needs', async () => {
    const onRequestDelete = vi.fn()
    renderPanel({ onRequestDelete })
    const menu = await contextMenuOnCard('Meeting notes')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete' }))
    expect(onRequestDelete).toHaveBeenCalledWith('meeting-notes', 'Meeting notes', 'markdown')
  })

  it('omits every verb whose handler the page does not provide', async () => {
    // Only Delete is wired here: Open, Duplicate must both be absent —
    // making any spread unconditional goes red.
    renderPanel({ onRequestDelete: () => {} })
    const menu = await contextMenuOnCard('Meeting notes')
    expect(within(menu).queryByRole('menuitem', { name: 'Duplicate' })).toBeNull()
    expect(within(menu).queryByRole('menuitem', { name: 'Open' })).toBeNull()
    expect(within(menu).getByRole('menuitem', { name: 'Delete' })).toBeTruthy()
  })

  it('omits Delete when only opening is wired', async () => {
    renderPanel({ onOpenDocument: () => {} })
    const menu = await contextMenuOnCard('Meeting notes')
    expect(within(menu).queryByRole('menuitem', { name: 'Delete' })).toBeNull()
    expect(within(menu).getByRole('menuitem', { name: 'Open' })).toBeTruthy()
  })

  it('plain selection never opens the rename dialog', async () => {
    // Selecting shows the document; only Rename… asks to change it.
    renderPanel({ onOpenDocument: () => {} })
    await waitFor(() => {
      expect(
        screen.getAllByTestId('card-title').some((el) => el.textContent === 'Meeting notes'),
      ).toBe(true)
    })
    const el = screen.getAllByTestId('card-title').find((n) => n.textContent === 'Meeting notes')
    fireEvent.click(el?.closest('button') as HTMLElement)
    await screen.findByTestId('okf-preview')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Rename… opens the dialog for exactly this document', async () => {
    renderPanel({ onOpenDocument: () => {} })
    const menu = await contextMenuOnCard('Meeting notes')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Rename…' }))
    const dialog = await screen.findByRole('dialog')
    expect((within(dialog).getByLabelText(/^Path/) as HTMLInputElement).value).toBe('meeting-notes')
    expect((within(dialog).getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Meeting notes')
  })

  it('a search result row opens the same menu, and Escape closes it', async () => {
    renderPanel({ onOpenDocument: () => {} })
    await waitFor(() => expect(screen.getAllByTestId('card-title').length).toBeGreaterThan(0))
    fireEvent.change(screen.getByLabelText('Search documents'), { target: { value: 'road' } })
    const row = await screen.findByTestId('result-title')
    fireEvent.contextMenu(row.closest('button') as HTMLElement, { clientX: 30, clientY: 30 })
    const menu = await screen.findByRole('menu', { name: 'Document actions' })
    fireEvent.keyDown(menu, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Document actions' })).toBeNull())
  })

  it('the grid layout of search results carries the menu too', async () => {
    renderPanel({ onOpenDocument: () => {} })
    await waitFor(() => expect(screen.getAllByTestId('card-title').length).toBeGreaterThan(0))
    fireEvent.change(screen.getByLabelText('Search documents'), { target: { value: 'road' } })
    await screen.findByTestId('search-results-list')
    fireEvent.click(screen.getByRole('button', { name: 'Grid results' }))
    const row = await screen.findByTestId('result-title')
    fireEvent.contextMenu(row.closest('button') as HTMLElement, { clientX: 30, clientY: 30 })
    expect(await screen.findByRole('menu', { name: 'Document actions' })).toBeTruthy()
  })

  it('a folder card opens no menu', async () => {
    renderPanel({ onOpenDocument: () => {} })
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Open folder plans' }).length).toBeGreaterThan(0)
    })
    fireEvent.contextMenu(screen.getAllByRole('button', { name: 'Open folder plans' })[0]!, {
      clientX: 30,
      clientY: 30,
    })
    expect(screen.queryByRole('menu', { name: 'Document actions' })).toBeNull()
  })
})

// Pinning was settable only from the editor header's document switcher until
// that switcher was retired. The ordering it feeds (compareDocumentEntries)
// outlived it, so the verb had to land on the object rather than vanish.
describe('document card context menu — pinning', () => {
  it('omits Pin when the backend cannot keep one', async () => {
    renderPanel({ onOpenDocument: () => {} })

    const menu = await contextMenuOnCard('Meeting notes')
    expect(within(menu).queryByRole('menuitem', { name: /^(pin|unpin)$/i })).toBeNull()
  })

  it('pins an unpinned document through the seam', async () => {
    const setPinned = vi.fn(async () => {})
    renderPanel({ setPinned })

    const menu = await contextMenuOnCard('Meeting notes')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Pin' }))

    await waitFor(() =>
      expect(setPinned).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'meeting-notes' }),
        true,
      ),
    )
  })

  it('offers Unpin for a document that is already pinned', async () => {
    const setPinned = vi.fn(async () => {})
    renderPanel({
      setPinned,
      rows: [{ ...entries[0]!, pinOrder: 0 }, entries[1]!],
    })

    const menu = await contextMenuOnCard('Meeting notes')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Unpin' }))

    await waitFor(() =>
      expect(setPinned).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'meeting-notes' }),
        false,
      ),
    )
  })
})
