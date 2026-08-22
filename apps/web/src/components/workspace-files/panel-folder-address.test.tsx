import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

afterEach(cleanup)

function sourceWithFolders() {
  return fakeFilesSource({
    listDocuments: () =>
      Promise.resolve([
        { documentId: 'd1', path: 'design/login', kind: 'spatial' as const },
        { documentId: 'd2', path: 'notes/weekly', kind: 'markdown' as const },
      ]),
  })
}

// The folder you are standing in is WHAT YOU ARE LOOKING AT, so it belongs in
// the address: a link to a folder should open that folder, a reload should
// not drop you at the root, and — the reason this landed now — creating a
// document can open it without the trip back costing you your place.
//
// `columns` deliberately does NOT live there. It is HOW you look, not what
// at, and a shared link must not impose the sender's column count on whoever
// opens it.
describe('WorkspaceFilesPanel — the open folder is an address', () => {
  it('starts in the folder it was given rather than at the root', async () => {
    render(<WorkspaceFilesPanel source={sourceWithFolders()} initialFolder="design" />)

    const contents = await screen.findByTestId('folder-contents')
    await waitFor(() => expect(within(contents).getByTestId('card-title')).toBeTruthy())
    expect(within(contents).getByTestId('card-title').textContent).toBe('login')
  })

  it('reports each move so the host can put it in the URL', async () => {
    const onFolderChange = vi.fn()
    render(
      <WorkspaceFilesPanel
        source={sourceWithFolders()}
        initialFolder=""
        onFolderChange={onFolderChange}
      />,
    )

    const contents = await screen.findByTestId('folder-contents')
    fireEvent.click(within(contents).getByRole('button', { name: 'Open folder notes' }))

    await waitFor(() => expect(onFolderChange).toHaveBeenCalledWith('notes'))
  })

  // A workspace switch resets to the root, and the host has to hear about it
  // or the URL keeps naming a folder in a workspace nobody is looking at.
  it('reports the reset when the source changes underneath it', async () => {
    const onFolderChange = vi.fn()
    const { rerender } = render(
      <WorkspaceFilesPanel
        source={sourceWithFolders()}
        initialFolder="design"
        onFolderChange={onFolderChange}
      />,
    )
    await screen.findByTestId('folder-contents')

    rerender(
      <WorkspaceFilesPanel
        source={sourceWithFolders()}
        initialFolder="design"
        onFolderChange={onFolderChange}
      />,
    )

    await waitFor(() => expect(onFolderChange).toHaveBeenCalledWith(''))
  })
})
