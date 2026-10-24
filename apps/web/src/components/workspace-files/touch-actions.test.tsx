// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

const rows = [
  { documentId: 'd1', path: 'design/login', name: 'Login flow', kind: 'spatial' as const },
  { documentId: 'd2', path: 'notes', name: 'Notes', kind: 'markdown' as const },
]

const realMatchMedia = window.matchMedia
let coarse = false
const mql = (matches: boolean, media: string) =>
  ({
    matches,
    media,
    addEventListener: () => {},
    removeEventListener: () => {},
  }) as unknown as MediaQueryList
beforeEach(() => {
  coarse = true
  window.matchMedia = (query: string) =>
    query === '(pointer: coarse)'
      ? mql(coarse, query)
      : realMatchMedia
        ? realMatchMedia.call(window, query)
        : mql(false, query)
})
afterEach(() => {
  cleanup()
  window.matchMedia = realMatchMedia
  localStorage.clear()
})

function renderPanel() {
  render(
    <WorkspaceFilesPanel
      source={fakeFilesSource({ listDocuments: async () => rows })}
      onOpenDocument={() => {}}
    />,
  )
}

describe('a touch user reaches the actions without a gesture', () => {
  it('a document card carries an actions button that opens the card menu', async () => {
    renderPanel()
    const grid = await screen.findByTestId('folder-contents')
    fireEvent.click(within(grid).getByRole('button', { name: 'Notes actions' }))
    const menu = await screen.findByRole('menu', { name: 'Document actions' })
    expect(within(menu).getByRole('menuitem', { name: 'Rename…' })).toBeTruthy()
  })

  it('a pointer that can hover is not given the button', async () => {
    coarse = false
    renderPanel()
    await screen.findByTestId('folder-contents')
    expect(screen.queryByRole('button', { name: /actions$/ })).toBeNull()
  })

  it('a folder card opens the folder menu with Rename and New subfolder', async () => {
    renderPanel()
    const grid = await screen.findByTestId('folder-contents')
    fireEvent.click(within(grid).getByRole('button', { name: 'design actions' }))
    const menu = await screen.findByRole('menu', { name: 'Folder actions' })
    expect(within(menu).getByRole('menuitem', { name: 'Rename…' })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: 'New subfolder…' })).toBeTruthy()
  })

  it('a folder tree row opens the folder menu', async () => {
    renderPanel()
    const tree = await screen.findByRole('tree', { name: 'Workspace folders' })
    fireEvent.click(within(tree).getByRole('button', { name: 'design actions' }))
    expect(await screen.findByRole('menu', { name: 'Folder actions' })).toBeTruthy()
  })

  it('a breadcrumb crumb opens the folder menu, the root offering only New subfolder', async () => {
    renderPanel()
    const trail = await screen.findByRole('navigation', { name: 'Folder path' })
    fireEvent.click(within(trail).getByRole('button', { name: 'Workspace actions' }))
    const menu = await screen.findByRole('menu', { name: 'Folder actions' })
    expect(within(menu).queryByRole('menuitem', { name: 'Rename…' })).toBeNull()
    expect(within(menu).getByRole('menuitem', { name: 'New subfolder…' })).toBeTruthy()
  })

  it('the actions button is a 44px target', async () => {
    renderPanel()
    const grid = await screen.findByTestId('folder-contents')
    const button = within(grid).getByRole('button', { name: 'Notes actions' })
    expect(button.className).toMatch(/size-11/)
  })

  it('a folder row of the one-column tree is a Tab stop that toggles its group', async () => {
    localStorage.setItem('whiteboard.document-browser.columns.v1', 'one')
    renderPanel()
    const tree = await screen.findByRole('tree', { name: 'Workspace documents' })
    const row = within(tree).getByRole('button', { name: 'design' })
    expect(row.tabIndex).toBe(0)
    expect(within(tree).getByRole('button', { name: /^Login flow$/ })).toBeTruthy()
    fireEvent.click(row)
    await waitFor(() =>
      expect(within(tree).queryByRole('button', { name: /^Login flow$/ })).toBeNull(),
    )
  })
})

describe('naming a folder starts with the caret in the field', () => {
  it('New subfolder focuses Folder name so typing and Enter land', async () => {
    renderPanel()
    const grid = await screen.findByTestId('folder-contents')
    fireEvent.click(within(grid).getByRole('button', { name: 'design actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New subfolder…' }))
    const dialog = await screen.findByRole('dialog', { name: 'New subfolder' })
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByLabelText('Folder name')),
    )
  })

  it('Move to folder > New folder… focuses Folder name', async () => {
    renderPanel()
    const grid = await screen.findByTestId('folder-contents')
    fireEvent.click(within(grid).getByRole('button', { name: 'Notes actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to folder…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move to folder' })
    fireEvent.click(within(dialog).getByRole('option', { name: 'New folder…' }))
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByLabelText('Folder name')),
    )
  })
})
