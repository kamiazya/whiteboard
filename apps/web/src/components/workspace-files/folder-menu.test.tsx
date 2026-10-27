// @vitest-environment jsdom
import { DisplayNameTakenError } from '@kamiazya/whiteboard-ports'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

afterEach(cleanup)

/**
 * A keeper that names folders the way both real ones do: by path, refusing
 * where no folder stands, and holding the documents' paths as they are.
 */
function renderWithFolders(
  options: {
    initialFolder?: string
    names?: Record<string, string>
    refuseName?: (path: string, name: string) => Error
  } = {},
) {
  let rows: WorkspaceDocumentEntry[] = [
    { documentId: 'd1', path: 'class/w6/notes', name: 'Notes', kind: 'markdown' },
    { documentId: 'd2', path: 'class/w7/notes', name: 'Notes', kind: 'markdown' },
    { documentId: 'd3', path: 'class/plan', name: 'Plan', kind: 'markdown' },
    { documentId: 'd4', path: 'class/plan/outline', name: 'Outline', kind: 'markdown' },
  ]
  const names = new Map<string, string>(Object.entries(options.names ?? {}))
  const source = fakeFilesSource({
    listDocuments: async () => rows,
    listFolderNames: async () => [...names].map(([path, name]) => ({ path, name })),
    setFolderName: async (path, name) => {
      const refused = name === undefined ? undefined : options.refuseName?.(path, name)
      if (refused !== undefined) throw refused
      if (name === undefined) names.delete(path)
      else names.set(path, name)
    },
    createDocument: async (path, kind, name) => {
      rows = [...rows, { documentId: `d${rows.length + 1}`, path, kind, ...(name ? { name } : {}) }]
    },
    renameDocumentPath: async (from, to) => {
      rows = rows.map((row) => (row.path === from ? { ...row, path: to } : row))
    },
  })
  const panel = (revision: number) => (
    <WorkspaceFilesPanel
      source={source}
      initialFolder={options.initialFolder ?? 'class'}
      revision={revision}
      onOpenDocument={() => {}}
    />
  )
  const { rerender } = render(panel(0))
  return { source, names, relist: () => rerender(panel(1)) }
}

/** A folder's own menu, from its card in the contents pane or its row in the tree. */
async function openFolderMenu(name: string, where: 'contents' | 'tree' = 'contents') {
  const scope =
    where === 'contents'
      ? await screen.findByTestId('folder-contents')
      : await screen.findByRole('tree', { name: 'Workspace folders' })
  const target = await within(scope).findByRole('button', { name: `Open folder ${name}` })
  fireEvent.contextMenu(target, { clientX: 5, clientY: 5 })
  return screen.findByRole('menu', { name: 'Folder actions' })
}

async function submitFolderName(
  menuItem: string,
  folder: string,
  value: string,
  where: 'contents' | 'tree' = 'contents',
) {
  const menu = await openFolderMenu(folder, where)
  fireEvent.click(within(menu).getByRole('menuitem', { name: menuItem }))
  const dialog = await screen.findByRole('dialog', {
    name: menuItem === 'Rename…' ? 'Rename folder' : 'New subfolder',
  })
  const field = within(dialog).getByLabelText('Folder name')
  fireEvent.change(field, { target: { value } })
  fireEvent.submit(field.closest('form') as HTMLFormElement)
  return dialog
}

describe('a folder’s display name', () => {
  it('renames a folder to "Week 6" without moving anything, and every surface shows it', async () => {
    const { source } = renderWithFolders()
    await submitFolderName('Rename…', 'w6', 'Week 6')

    await waitFor(() => expect(source.setFolderName).toHaveBeenCalledWith('class/w6', 'Week 6'))
    expect(source.renameDocumentPath).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    const contents = await screen.findByTestId('folder-contents')
    expect(within(contents).getByRole('button', { name: 'Open folder Week 6' })).toBeTruthy()
    const tree = screen.getByRole('tree', { name: 'Workspace folders' })
    expect(within(tree).getByRole('button', { name: 'Open folder Week 6' })).toBeTruthy()
    expect(screen.getAllByRole('status').map((each) => each.textContent)).toContain(
      'Renamed folder w6 to Week 6',
    )

    fireEvent.click(within(contents).getByRole('button', { name: 'Open folder Week 6' }))
    const trail = await screen.findByRole('navigation', { name: 'Folder path' })
    await waitFor(() => expect(within(trail).getByRole('button', { name: 'Week 6' })).toBeTruthy())
    // The address is the one it always had.
    expect(trail.querySelector('[aria-current="true"]')?.getAttribute('data-folder-path')).toBe(
      'class/w6',
    )
  })

  it('refuses a name a sibling folder already shows, before asking the keeper', async () => {
    const { source } = renderWithFolders({ names: { 'class/w6': 'Week 6' } })
    await within(await screen.findByTestId('folder-contents')).findByRole('button', {
      name: 'Open folder Week 6',
    })
    const dialog = await submitFolderName('Rename…', 'w7', ' week 6 ')
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Another folder in this folder is already called "week 6". Choose a name no other folder beside it has.',
    )
    expect(source.setFolderName).not.toHaveBeenCalled()
  })

  it('shows the keeper’s own refusal of a duplicate it could not see here', async () => {
    renderWithFolders({
      refuseName: (path, name) => new DisplayNameTakenError('folder', path, name),
    })
    const dialog = await submitFolderName('Rename…', 'w7', 'Week 6')
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Another folder in this folder is already called "Week 6". Choose a name no other folder beside it has.',
    )
  })

  it('refuses a name with a slash before asking the keeper', async () => {
    const { source } = renderWithFolders()
    const dialog = await submitFolderName('Rename…', 'w6', 'a/b')
    expect((await within(dialog).findByRole('alert')).textContent).toContain('"/"')
    expect(source.setFolderName).not.toHaveBeenCalled()
  })

  it('offers no Rename… on a document that is also a folder, which has no folder to name', async () => {
    renderWithFolders()
    const menu = await openFolderMenu('plan')
    expect(within(menu).queryByRole('menuitem', { name: 'Rename…' })).toBeNull()
    expect(within(menu).getByRole('menuitem', { name: 'New subfolder…' })).toBeTruthy()
  })
})

describe('a new subfolder', () => {
  it('opens under the name it was given and writes it once a document lands there', async () => {
    const { source, relist } = renderWithFolders()
    await submitFolderName('New subfolder…', 'w6', 'Week 8')

    const trail = await screen.findByRole('navigation', { name: 'Folder path' })
    await waitFor(() => expect(within(trail).getByRole('button', { name: 'Week 8' })).toBeTruthy())
    expect(trail.querySelector('[aria-current="true"]')?.getAttribute('data-folder-path')).toBe(
      'class/w6/week-8',
    )
    // Nothing is stored for an empty folder.
    expect(source.setFolderName).not.toHaveBeenCalled()

    // A document lands there from elsewhere; the next listing holds it, and
    // the name follows it into the keeper.
    await source.createDocument('class/w6/week-8/untitled', 'markdown')
    relist()
    await waitFor(() =>
      expect(source.setFolderName).toHaveBeenCalledWith('class/w6/week-8', 'Week 8'),
    )
  })

  it('refuses a name a sibling folder already shows, its segment included', async () => {
    renderWithFolders()
    const dialog = await submitFolderName('New subfolder…', 'class', 'W7', 'tree')
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Another folder in this folder is already called "W7". Choose a name no other folder beside it has.',
    )
    expect(dialog.isConnected).toBe(true)
  })
})
