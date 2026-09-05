// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

// What a re-read must not do is throw the layout away and put it back.
// Measured on a real workspace switch before this: the panel's box went
// 552px -> 0 -> 552 and the card area jumped up 38px and back, inside 54ms.
// jsdom has no layout, so the assertion is on the STRUCTURE that produced
// it — the toolbar stays mounted, and the card area is a grid of the same
// shape rather than a line of text.

afterEach(cleanup)

const entries: WorkspaceDocumentEntry[] = [
  { documentId: 'd1', path: 'one', name: 'One', kind: 'markdown' },
  { documentId: 'd2', path: 'two', name: 'Two', kind: 'spatial' },
]

describe('a re-read holds the panel’s layout', () => {
  it('keeps the toolbar and reserves the grid while the new list loads', async () => {
    // A SWITCH is a new source identity — that is the panel's own signal, and
    // the only path that clears the list (a `revision` bump deliberately
    // keeps the cards up while it re-reads the same workspace).
    const settled = fakeFilesSource({ listDocuments: () => Promise.resolve(entries) })
    // The trash is the panel's OTHER list of the departed workspace's
    // documents, and it reads on its own — so a switch has to take it away
    // with the cards rather than leave it holding rows from the workspace
    // that was left.
    settled.listTrash = async () => [
      { documentId: 'gone-1', path: 'left-behind/plan', deletedAt: 1_700_000 },
    ]
    settled.restoreFromTrash = async () => {}
    let release: ((rows: readonly WorkspaceDocumentEntry[]) => void) | undefined
    const switching = fakeFilesSource({
      listDocuments: () =>
        new Promise((resolve) => {
          release = resolve
        }),
    })
    // Hanging on purpose: the window worth pinning is the one where the NEW
    // workspace's trash has not answered yet. Resolved fast, the section
    // re-reads within a microtask and nothing about the departed rows is
    // observable at all.
    switching.listTrash = () => new Promise(() => {})
    switching.restoreFromTrash = async () => {}

    const { rerender } = render(<WorkspaceFilesPanel source={settled} />)
    await waitFor(() => expect(screen.getAllByTestId('card-title')).toHaveLength(2))
    // The precondition, asserted rather than assumed: the trash section is
    // ON SCREEN for the settled workspace, so its absence below means the
    // switch took it away rather than that it was never there.
    await screen.findByText(/^Trash/)

    rerender(<WorkspaceFilesPanel source={switching} />)

    const loading = await screen.findByRole('status', { name: 'Loading documents' })
    // The toolbar is what sits ABOVE the cards; losing it is what moved them.
    expect(screen.getByRole('searchbox', { name: 'Search documents' })).toBeTruthy()
    // Room for what is coming, in the same grid the cards use, and as many
    // placeholders as the list it is replacing.
    expect(loading.className).toContain('grid')
    expect(loading.children).toHaveLength(2)
    // Nothing from the departed workspace is still on screen — its trash
    // included, which is a second list of its documents, reads on its own,
    // and here has not answered for the new workspace yet.
    expect(screen.queryAllByTestId('card-title')).toHaveLength(0)
    expect(screen.queryByText(/^Trash/)).toBeNull()

    release?.([entries[0] as WorkspaceDocumentEntry])
    await waitFor(() => expect(screen.getAllByTestId('card-title')).toHaveLength(1))
  })
})
