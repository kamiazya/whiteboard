// @vitest-environment jsdom
/**
 * The panel's Trash section: what a delete evacuated, restorable in place.
 *
 * The section renders only when the source CAN answer (the capability is
 * optional, like `setPinned`) and only when there is something in it — an
 * empty trash is silence, not an empty box.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

afterEach(cleanup)

const ENTRY = { documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', path: 'old/plan', deletedAt: 1_700_000 }

describe('WorkspaceFilesPanel trash section', () => {
  it('lists evacuated documents and restore calls the source, then both lists refresh', async () => {
    let trash = [ENTRY]
    const source = fakeFilesSource({
      listDocuments: async () =>
        trash.length > 0
          ? [{ documentId: 'd-live', path: 'live', kind: 'markdown' as const }]
          : [
              { documentId: 'd-live', path: 'live', kind: 'markdown' as const },
              { documentId: ENTRY.documentId, path: ENTRY.path, kind: 'spatial' as const },
            ],
    })
    source.listTrash = vi.fn(async () => trash)
    source.restoreFromTrash = vi.fn(async (documentId: string) => {
      trash = trash.filter((entry) => entry.documentId !== documentId)
    })
    render(<WorkspaceFilesPanel source={source} />)

    fireEvent.click(await screen.findByText(/^Trash/))
    await screen.findByText('old/plan')

    fireEvent.click(screen.getByRole('button', { name: /restore/i }))

    await waitFor(() => {
      expect(source.restoreFromTrash).toHaveBeenCalledWith(ENTRY.documentId)
    })
    // Restored: the entry leaves the trash, and the document list re-reads.
    await waitFor(() => {
      expect(screen.queryByText('old/plan')).toBeNull()
    })
  })

  it('renders no trash section when the trash is empty', async () => {
    const source = fakeFilesSource({
      listDocuments: async () => [{ documentId: 'd1', path: 'doc', kind: 'markdown' as const }],
    })
    source.listTrash = vi.fn(async () => [])
    render(<WorkspaceFilesPanel source={source} />)
    await screen.findAllByTestId('card-title')

    expect(screen.queryByText(/^Trash/)).toBeNull()
  })

  it('renders no trash section when the source has no trash capability', async () => {
    const source = fakeFilesSource({
      listDocuments: async () => [{ documentId: 'd1', path: 'doc', kind: 'markdown' as const }],
    })
    render(<WorkspaceFilesPanel source={source} />)
    await screen.findAllByTestId('card-title')

    expect(screen.queryByText(/^Trash/)).toBeNull()
  })
})
