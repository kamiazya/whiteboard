// @vitest-environment jsdom
/**
 * A refresh behind the panel's back re-resolves what the panel POINTS AT.
 *
 * Every pointer is a captured row, taken before the list was re-read, so
 * after one it is either stale or naming a document that is gone. The rule
 * is one `reconcile` in use-document-pointers.ts; this file covers the
 * selection and the card menu, and `peek.test.tsx`'s "peek follows the
 * list" covers the third arm beside the rest of the peek's setup.
 *
 * Both arms were UNWATCHED before this: deleting either from `reconcile`
 * left all 288 jsdom tests green, including the one that names the menu's
 * behaviour in a comment.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

afterEach(cleanup)

const before: readonly WorkspaceDocumentEntry[] = [
  { documentId: 'd1', path: 'meeting-notes', name: 'Meeting notes', kind: 'markdown' },
]

async function selectFirstCard() {
  await waitFor(() => {
    expect(screen.getAllByTestId('card-title').length).toBeGreaterThan(0)
  })
  fireEvent.click(screen.getAllByTestId('card-title')[0]?.closest('button') as HTMLElement)
}

describe('a pointer follows the list it was taken from', () => {
  it('shows the selected document as the re-read now describes it', async () => {
    let rows = before
    const source = fakeFilesSource({ listDocuments: () => Promise.resolve(rows) })
    const { rerender } = render(
      <WorkspaceFilesPanel source={source} onOpenDocument={vi.fn()} revision={0} />,
    )

    await selectFirstCard()
    const preview = await screen.findByTestId('okf-preview')
    expect(within(preview).getByText('Meeting notes')).toBeTruthy()

    rows = [{ ...(before[0] as WorkspaceDocumentEntry), name: 'Standup notes' }]
    rerender(<WorkspaceFilesPanel source={source} onOpenDocument={vi.fn()} revision={1} />)

    await waitFor(() => {
      expect(within(screen.getByTestId('okf-preview')).getByText('Standup notes')).toBeTruthy()
    })
  })

  it('empties the preview when the selected document is gone', async () => {
    let rows = before
    const source = fakeFilesSource({ listDocuments: () => Promise.resolve(rows) })
    const { rerender } = render(
      <WorkspaceFilesPanel source={source} onOpenDocument={vi.fn()} revision={0} />,
    )

    await selectFirstCard()
    await screen.findByTestId('okf-preview')

    rows = []
    rerender(<WorkspaceFilesPanel source={source} onOpenDocument={vi.fn()} revision={1} />)

    await waitFor(() => expect(screen.queryByTestId('okf-preview')).toBeNull())
  })

  it('closes the object menu rather than offering verbs for a document that is gone', async () => {
    let rows = before
    const source = fakeFilesSource({ listDocuments: () => Promise.resolve(rows) })
    const { rerender } = render(
      <WorkspaceFilesPanel source={source} onOpenDocument={vi.fn()} revision={0} />,
    )

    await waitFor(() => {
      expect(screen.getAllByTestId('card-title').length).toBeGreaterThan(0)
    })
    fireEvent.contextMenu(
      screen.getAllByTestId('card-title')[0]?.closest('button') as HTMLElement,
      {
        clientX: 40,
        clientY: 40,
      },
    )
    await screen.findByRole('menu', { name: 'Document actions' })

    rows = []
    rerender(<WorkspaceFilesPanel source={source} onOpenDocument={vi.fn()} revision={1} />)

    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Document actions' })).toBeNull())
  })
})
