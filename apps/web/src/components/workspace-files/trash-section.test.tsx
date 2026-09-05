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
import type { TrashRow } from '../../lib/files-source.js'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { TrashSection } from './TrashSection.js'
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

  it('announces a failed restore and keeps the row, instead of silently reloading', async () => {
    const source = fakeFilesSource({
      listDocuments: async () => [
        { documentId: 'd-live', path: 'live', kind: 'markdown' as const },
      ],
    })
    source.listTrash = vi.fn(async () => [ENTRY])
    source.restoreFromTrash = vi.fn(async () => {
      throw new Error('nothing restorable')
    })
    render(<WorkspaceFilesPanel source={source} />)

    fireEvent.click(await screen.findByText(/^Trash/))
    fireEvent.click(await screen.findByRole('button', { name: /restore/i }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Could not restore')
    expect(screen.getByText('old/plan')).toBeTruthy()
  })

  it('ignores a trash read superseded by a newer reload', async () => {
    // The mount-time list is slow; a revision bump (a delete landing, say)
    // starts a second read that answers first. When the FIRST finally
    // resolves, its stale rows must not overwrite the newer answer — that is
    // how a restored row climbs back into the section.
    let resolveFirst: (rows: readonly TrashRow[]) => void = () => undefined
    const first = new Promise<readonly TrashRow[]>((resolve) => {
      resolveFirst = resolve
    })
    let calls = 0
    const listTrash = vi.fn(() => {
      calls += 1
      return calls === 1 ? first : Promise.resolve<readonly TrashRow[]>([])
    })
    const { rerender } = render(
      <TrashSection
        listTrash={listTrash}
        restoreFromTrash={async () => undefined}
        onRestored={() => undefined}
        revision={0}
      />,
    )
    rerender(
      <TrashSection
        listTrash={listTrash}
        restoreFromTrash={async () => undefined}
        onRestored={() => undefined}
        revision={1}
      />,
    )
    await waitFor(() => expect(listTrash).toHaveBeenCalledTimes(2))

    resolveFirst([ENTRY])
    // Give the stale resolution a chance to (wrongly) apply itself.
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByText('old/plan')).toBeNull()
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
