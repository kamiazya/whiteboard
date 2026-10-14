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

  // Two windows, one per await in the create: the write itself, and the
  // re-read that follows it. A switch in either leaves a result that names
  // the departed workspace.
  it.each([
    ['the write', 'write'],
    ['the re-read after it', 'reread'],
  ] as const)('a switch during %s opens and remembers nothing', async (_, held) => {
    let finish: () => void = () => {}
    const hold = () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
    const seed: readonly WorkspaceDocumentEntry[] = [
      { documentId: 'd1', path: 'seed', kind: 'markdown' },
    ]
    let lists = 0
    const departed = fakeFilesSource({
      listDocuments: async () => {
        lists += 1
        if (held === 'reread' && lists > 1) await hold()
        return lists > 1
          ? [...seed, { documentId: 'd2', path: 'untitled', kind: 'markdown' }]
          : seed
      },
      createDocument: held === 'write' ? hold : async () => {},
    })
    const next = fakeFilesSource({
      listDocuments: async () => [{ documentId: 'e1', path: 'other', kind: 'markdown' }],
    })
    const onOpenDocument = vi.fn()
    const { rerender } = render(
      <WorkspaceFilesPanel
        source={departed}
        onOpenDocument={onOpenDocument}
        memoryScope="browser:A"
      />,
    )
    await screen.findAllByTestId('card-title')
    await pickNewDocumentKind('markdown')
    await waitFor(() =>
      expect(departed.listDocuments).toHaveBeenCalledTimes(held === 'write' ? 1 : 2),
    )
    await waitFor(() => expect(departed.createDocument).toHaveBeenCalled())

    rerender(
      <WorkspaceFilesPanel source={next} onOpenDocument={onOpenDocument} memoryScope="browser:B" />,
    )
    await waitFor(() => expect(next.listDocuments).toHaveBeenCalled())
    finish()

    // The create's own `finally` is what re-enables the menu, so this waits
    // for the whole create to settle rather than for time.
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'New document' }).disabled).toBe(
        false,
      ),
    )
    expect(onOpenDocument).not.toHaveBeenCalled()
    expect(readRecentIds('browser:B')).toEqual([])
    // The departed workspace's list is not read back onto this one.
    expect(screen.queryByText('seed')).toBeNull()
  })
})
