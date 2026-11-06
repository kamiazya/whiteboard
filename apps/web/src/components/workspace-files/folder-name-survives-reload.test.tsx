// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { writePendingFolderNames } from './pending-folder-names-store.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

afterEach(() => {
  cleanup()
  sessionStorage.clear()
})

/**
 * One keeper across "reloads": each mount is a fresh page in the same tab,
 * which keeps sessionStorage and nothing else.
 */
function keeper() {
  let rows: WorkspaceDocumentEntry[] = [
    { documentId: 'd1', path: 'notes', name: 'Notes', kind: 'markdown' },
  ]
  const names = new Map<string, string>()
  const source = fakeFilesSource({
    listDocuments: async () => rows,
    listFolderNames: async () => [...names].map(([path, name]) => ({ path, name })),
    setFolderName: async (path, name) => {
      if (name !== undefined) names.set(path, name)
    },
    createDocument: async (path, kind) => {
      rows = [...rows, { documentId: `d${rows.length + 1}`, path, kind }]
      return path
    },
  })
  const panel = (initialFolder: string, memoryScope: string) => (
    <WorkspaceFilesPanel
      source={source}
      initialFolder={initialFolder}
      memoryScope={memoryScope}
      onOpenDocument={() => {}}
    />
  )
  const mount = (initialFolder: string, memoryScope = 'browser:w1') =>
    render(panel(initialFolder, memoryScope))
  return { source, names, mount, panel }
}

async function newFolder(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'New folder' }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.change(within(dialog).getByLabelText('Folder name'), { target: { value: name } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create folder' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
}

async function trailSays(name: string) {
  const trail = await screen.findByRole('navigation', { name: 'Folder path' })
  await waitFor(() => expect(within(trail).getByRole('button', { name })).toBeTruthy())
}

describe('an empty named folder across a reload in the same tab', () => {
  it('keeps its name', async () => {
    const { mount } = keeper()
    const first = mount('')
    await newFolder('Workshops')
    first.unmount()

    mount('workshops')
    await trailSays('Workshops')
  })

  it('gives a subfolder made after the reload both names when a document lands', async () => {
    const { source, mount } = keeper()
    writePendingFolderNames('browser:w1', new Map([['workshops', 'Workshops']]))
    mount('workshops')
    await trailSays('Workshops')
    await newFolder('Template')
    await trailSays('Template')

    const contents = await screen.findByTestId('folder-contents')
    fireEvent.click(await within(contents).findByRole('button', { name: 'New note here' }))
    await waitFor(() => expect(source.setFolderName).toHaveBeenCalledWith('workshops', 'Workshops'))
    expect(source.setFolderName).toHaveBeenCalledWith('workshops/template', 'Template')
  })

  it('belongs to its workspace alone', async () => {
    const { mount } = keeper()
    const first = mount('')
    await newFolder('Workshops')
    first.unmount()

    mount('workshops', 'browser:w2')
    const trail = await screen.findByRole('navigation', { name: 'Folder path' })
    await waitFor(() =>
      expect(within(trail).getByRole('button', { name: 'workshops' })).toBeTruthy(),
    )
    expect(within(trail).queryByRole('button', { name: 'Workshops' })).toBeNull()
  })
})

describe('switching workspace in place', () => {
  it('does not hand the departed workspace its pending names', async () => {
    const { mount } = keeper()
    const first = mount('')
    await newFolder('Workshops')
    const other = keeper()
    first.rerender(other.panel('', 'browser:w2'))
    await screen.findByTestId('folder-contents')
    first.unmount()

    other.mount('workshops', 'browser:w2')
    const trail = await screen.findByRole('navigation', { name: 'Folder path' })
    await waitFor(() =>
      expect(within(trail).getByRole('button', { name: 'workshops' })).toBeTruthy(),
    )
  })
})
