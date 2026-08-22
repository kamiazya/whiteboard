// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
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
  } = {},
) {
  const source = fakeFilesSource({ listDocuments: () => Promise.resolve(entries) })
  render(<WorkspaceFilesPanel source={source} {...overrides} />)
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
    for (const label of ['Open', 'Duplicate', 'Move…', 'Delete']) {
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

  it('plain selection never opens the move form', async () => {
    // The startMoveToken guard: only a Move… bump starts an edit —
    // clicking a card to select it must not.
    renderPanel({ onOpenDocument: () => {} })
    await waitFor(() => {
      expect(
        screen.getAllByTestId('card-title').some((el) => el.textContent === 'Meeting notes'),
      ).toBe(true)
    })
    const el = screen.getAllByTestId('card-title').find((n) => n.textContent === 'Meeting notes')
    fireEvent.click(el?.closest('button') as HTMLElement)
    await screen.findByTestId('okf-preview')
    expect(screen.queryByLabelText('Path')).toBeNull()
  })

  it('Move… selects the document and opens the move form', async () => {
    renderPanel({ onOpenDocument: () => {} })
    const menu = await contextMenuOnCard('Meeting notes')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move…' }))
    // The preview's path form appears for exactly this document, ready to edit.
    const input = await screen.findByLabelText('Path')
    expect((input as HTMLInputElement).value).toBe('meeting-notes')
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
