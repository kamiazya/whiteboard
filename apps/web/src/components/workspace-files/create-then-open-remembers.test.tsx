// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { readRecentIds } from '../../lib/recent-documents.js'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { pickNewDocumentKind } from '../../test-utils/new-document-menu.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

// A create ends in an open, and that open is this device's like any other:
// the new document enters the Recent lane the moment it is opened.

afterEach(cleanup)

function growingSource() {
  let rows: readonly WorkspaceDocumentEntry[] = [
    { documentId: 'd1', path: 'seed', kind: 'markdown' },
  ]
  return fakeFilesSource({
    listDocuments: async () => rows,
    createDocument: async (path, kind) => {
      rows = [...rows, { documentId: 'd2', path, kind }]
    },
  })
}

describe('create, then open', () => {
  it('remembers the document it opens', async () => {
    const source = growingSource()
    const onOpenDocument = vi.fn()
    render(
      <WorkspaceFilesPanel
        source={source}
        onOpenDocument={onOpenDocument}
        memoryScope="browser:W"
      />,
    )
    await screen.findAllByTestId('card-title')

    await pickNewDocumentKind('markdown')

    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledWith('untitled'))
    expect(readRecentIds('browser:W')).toEqual(['d2'])
  })

  it('remembers nothing where the host offers no open', async () => {
    // The create still selects the new document; looking is not opening.
    const source = growingSource()
    render(<WorkspaceFilesPanel source={source} memoryScope="browser:W" />)
    await screen.findAllByTestId('card-title')

    await pickNewDocumentKind('markdown')

    await waitFor(() => expect(source.listDocuments).toHaveBeenCalledTimes(2))
    await screen.findByTestId('okf-preview')
    expect(readRecentIds('browser:W')).toEqual([])
  })
})
