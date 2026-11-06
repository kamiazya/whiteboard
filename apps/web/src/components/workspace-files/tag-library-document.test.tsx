// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { DeleteDocumentsDialog } from '../document-list/DeleteDocumentsDialog.js'
import { DocumentPreview } from './DocumentPreview.js'
import { EMPTY_DOCUMENT } from './load-row-render.js'
import { SearchResults } from './SearchResults.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

afterEach(cleanup)

const library: WorkspaceDocumentEntry = { documentId: 't', path: 'tags', kind: 'markdown' }
const roadmap: WorkspaceDocumentEntry = {
  documentId: 'r',
  path: 'roadmap',
  name: 'Roadmap',
  kind: 'spatial',
}

describe('the stored tag library in the document list', () => {
  it('is labelled as the tag library on its card, and an ordinary document is not', async () => {
    render(
      <WorkspaceFilesPanel
        source={fakeFilesSource({ listDocuments: async () => [library, roadmap] })}
        onOpenDocument={() => {}}
      />,
    )
    const grid = await screen.findByTestId('folder-contents')
    const card = await within(grid).findByRole('button', { name: /^tags/ })
    expect(within(card).getByText('Tag library')).toBeTruthy()
    const described = (card.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent)
    expect(described).toContain('Tag library')
    const other = within(grid).getByRole('button', { name: /^Roadmap/ })
    expect(within(other).queryByText('Tag library')).toBeNull()
  })

  it('previews as what it keeps rather than as an empty note', async () => {
    render(<DocumentPreview document={library} loadRender={async () => EMPTY_DOCUMENT} />)
    expect(await screen.findByText(/keeps this workspace's tag colours/)).toBeTruthy()
    expect(screen.queryByText('Nothing written yet.')).toBeNull()
  })

  it('is labelled as the tag library among search results', () => {
    render(
      <SearchResults
        results={[{ document: library }, { document: roadmap }]}
        query="a"
        onSelect={vi.fn()}
      />,
    )
    expect(screen.getAllByTestId('tag-library-badge')).toHaveLength(1)
  })

  it('warns before it is deleted that the tag colours go with it', () => {
    render(
      <DeleteDocumentsDialog
        pending={{ displayName: 'tags', kind: 'markdown', path: 'tags', tagLibrary: true }}
        busy={false}
        error={null}
        action="delete-document"
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )
    expect(screen.getByText(/every tag colour set in this workspace/)).toBeTruthy()
  })
})
