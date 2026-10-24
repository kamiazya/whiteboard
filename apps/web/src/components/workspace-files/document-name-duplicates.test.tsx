// @vitest-environment jsdom
import { DisplayNameTakenError } from '@kamiazya/whiteboard-ports'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

const COMPACT = '(pointer: coarse), (max-width: 639px)'
const realMatchMedia = window.matchMedia
let compact = false

beforeEach(() => {
  compact = false
  window.matchMedia = (query: string) =>
    ({
      matches: query === COMPACT ? compact : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList
})
afterEach(() => {
  window.matchMedia = realMatchMedia
  cleanup()
})

const TAKEN =
  'Another document in "week" is already called "plan". Choose a name no other document beside it has.'

function renderPanel(overrides: Parameters<typeof fakeFilesSource>[0] = {}) {
  const rows: WorkspaceDocumentEntry[] = [
    { documentId: 'd1', path: 'week/a', name: 'Plan', kind: 'markdown' },
    { documentId: 'd2', path: 'week/b', name: 'Notes', kind: 'markdown' },
    // Another folder: the same name there is no duplicate.
    { documentId: 'd3', path: 'other/c', name: 'Draft', kind: 'markdown' },
  ]
  const source = fakeFilesSource({ listDocuments: async () => rows, ...overrides })
  render(<WorkspaceFilesPanel source={source} initialFolder="week" onOpenDocument={() => {}} />)
  return source
}

async function openRename(title: string) {
  const card = (await screen.findAllByTestId('card-title'))
    .find((each) => each.textContent === title)
    ?.closest('button') as HTMLElement
  fireEvent.contextMenu(card, { clientX: 5, clientY: 5 })
  const menu = await screen.findByRole('menu', { name: 'Document actions' })
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Rename…' }))
  return screen.findByRole('dialog', { name: 'Rename' })
}

function submitName(dialog: HTMLElement, name: string) {
  const field = within(dialog).getByLabelText(/^Name/)
  fireEvent.change(field, { target: { value: name } })
  fireEvent.submit(field.closest('form') as HTMLFormElement)
}

describe('a document named as a sibling already is', () => {
  it('is refused on Rename… before anything is sent', async () => {
    const source = renderPanel()
    const dialog = await openRename('Notes')
    submitName(dialog, ' plan ')
    expect((await within(dialog).findByRole('alert')).textContent).toBe(TAKEN)
    expect(source.setDocumentName).not.toHaveBeenCalled()
  })

  it('keeps its own name in another case, and may take a name used in another folder', async () => {
    const source = renderPanel()
    submitName(await openRename('Plan'), 'PLAN')
    await waitFor(() =>
      expect(source.setDocumentName).toHaveBeenCalledWith(
        expect.objectContaining({ documentId: 'd1' }),
        'PLAN',
      ),
    )
    submitName(await openRename('Notes'), 'Draft')
    await waitFor(() =>
      expect(source.setDocumentName).toHaveBeenCalledWith(
        expect.objectContaining({ documentId: 'd2' }),
        'Draft',
      ),
    )
  })

  it('shows the keeper’s own refusal of a duplicate it could not see here', async () => {
    renderPanel({
      setDocumentName: async (entry, name) => {
        throw new DisplayNameTakenError('document', entry.path, name ?? '')
      },
    })
    const dialog = await openRename('Notes')
    submitName(dialog, 'plan')
    expect((await within(dialog).findByRole('alert')).textContent).toBe(TAKEN)
  })

  it('is refused by Name and folder… without creating anything', async () => {
    const source = renderPanel()
    await screen.findAllByTestId('card-title')
    fireEvent.pointerDown(screen.getByRole('button', { name: /new document/i }), { button: 0 })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Name and folder/ }))
    const dialog = await screen.findByRole('dialog', { name: 'New document' })
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'plan' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
    expect((await within(dialog).findByRole('alert')).textContent).toBe(TAKEN)
    expect(source.createDocument).not.toHaveBeenCalled()
  })

  it('is refused by the phone sheet without creating anything', async () => {
    compact = true
    const source = renderPanel()
    await screen.findAllByTestId('card-title')
    fireEvent.click(screen.getByRole('button', { name: 'New document' }))
    const sheet = await screen.findByRole('dialog', { name: 'New document' })
    fireEvent.change(within(sheet).getByLabelText(/^Name/), { target: { value: 'Plan' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Markdown note' }))
    await waitFor(() =>
      expect(within(sheet).getByRole('alert').textContent).toBe(
        'Another document in "week" is already called "Plan". Choose a name no other document beside it has.',
      ),
    )
    expect(source.createDocument).not.toHaveBeenCalled()
  })
})
