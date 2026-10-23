import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { NewDocumentMenu } from './NewDocumentMenu.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

const COMPACT = '(pointer: coarse), (max-width: 639px)'
const realMatchMedia = window.matchMedia
let compact = true

beforeEach(() => {
  compact = true
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

function press() {
  fireEvent.click(screen.getByRole('button', { name: 'New document' }))
}

describe('New document sheet on a phone', () => {
  it('opens a sheet whose first field is the name, focused', async () => {
    render(<NewDocumentMenu onCreate={vi.fn()} defaultPath="untitled" />)
    press()

    const dialog = await screen.findByRole('dialog', { name: 'New document' })
    const name = await screen.findByLabelText(/^Name/)
    expect(dialog.querySelector('input, button:not([data-slot="dialog-close"])')).toBe(name)
    expect(document.activeElement).toBe(name)
  })

  it('creates the chosen kind under the typed name at an address derived from it', async () => {
    const onCreate = vi.fn()
    render(
      <NewDocumentMenu
        onCreate={onCreate}
        defaultPath="untitled"
        pathForName={(name) => name.toLowerCase().replace(/\s+/g, '-')}
      />,
    )
    press()
    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: 'Meeting Notes' } })
    fireEvent.click(screen.getByRole('button', { name: 'Markdown note' }))

    expect(onCreate).toHaveBeenCalledWith('markdown', {
      path: 'meeting-notes',
      name: 'Meeting Notes',
    })
  })

  it('keeps the generated address and sends no name when none was typed', async () => {
    const onCreate = vi.fn()
    render(<NewDocumentMenu onCreate={onCreate} defaultPath="untitled-2" />)
    press()
    fireEvent.click(await screen.findByRole('button', { name: 'Canvas' }))

    expect(onCreate).toHaveBeenCalledWith('spatial', { path: 'untitled-2', name: undefined })
  })

  it('stays the dropdown menu where there is room and a mouse', async () => {
    compact = false
    render(<NewDocumentMenu onCreate={vi.fn()} defaultPath="untitled" />)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'New document' }), { button: 0 })
    await screen.findByTestId('new-document-spatial')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('New document sheet in the document browser', () => {
  it('stores the typed name and files it at the address that name earns', async () => {
    const source = fakeFilesSource({
      listDocuments: () =>
        Promise.resolve([{ documentId: 'd1', path: 'meeting-notes', kind: 'markdown' as const }]),
      createDocument: vi.fn(() => Promise.resolve()),
    })
    render(<WorkspaceFilesPanel source={source} />)
    await screen.findAllByTestId('card-title')

    press()
    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: 'Meeting notes' } })
    fireEvent.click(screen.getByRole('button', { name: 'Markdown note' }))

    // Taken by the existing document, so the derived address numbers from -2.
    expect(source.createDocument).toHaveBeenCalledWith(
      'meeting-notes-2',
      'markdown',
      'Meeting notes',
    )
  })
})
