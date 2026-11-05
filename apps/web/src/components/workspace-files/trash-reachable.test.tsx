// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

afterEach(cleanup)

function renderWithTrash() {
  const source = fakeFilesSource({
    listDocuments: async () => [
      { documentId: 'd1', path: 'org/roster', name: 'Roster', kind: 'markdown' as const },
    ],
    listFolderNames: async () => [{ path: 'org', name: 'Operations Team' }],
  })
  source.listTrash = vi.fn(async () => [
    { documentId: 't1', path: 'org/untitled-11', name: 'Org chart', deletedAt: 1_700_000 },
  ])
  source.restoreFromTrash = vi.fn(async () => undefined)
  render(<WorkspaceFilesPanel source={source} onOpenDocument={() => {}} />)
}

describe('the trash, from the top of the panel', () => {
  it('sits above the list, with its count', async () => {
    renderWithTrash()
    const summary = await screen.findByText('Trash (1)')
    const contents = await screen.findByTestId('folder-contents')
    expect(
      summary.compareDocumentPosition(contents) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('names where a row was by its folder’s name, the address last', async () => {
    renderWithTrash()
    fireEvent.click(await screen.findByText('Trash (1)'))
    const row = (await screen.findByText('Org chart')).closest('li') as HTMLElement
    const text = row.textContent ?? ''
    expect(text).toContain('In Operations Team')
    expect(text.indexOf('Operations Team')).toBeLessThan(text.indexOf('org/untitled-11'))
  })
})
