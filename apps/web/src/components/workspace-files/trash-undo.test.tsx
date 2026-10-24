import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TrashRow } from '../../lib/files-source.js'
import { TrashSection } from './TrashSection.js'

afterEach(cleanup)

const row = (documentId: string, path: string, name?: string): TrashRow => ({
  documentId,
  path,
  ...(name === undefined ? {} : { name }),
  deletedAt: Date.parse('2026-09-28T00:00:00Z'),
})

describe('Trash after a delete', () => {
  it('offers Undo for the document that just arrived, and restores it', async () => {
    let listed: readonly TrashRow[] = []
    const restore = vi.fn(() => Promise.resolve())
    const onRestored = vi.fn()
    const ui = (revision: number) => (
      <TrashSection
        listTrash={() => Promise.resolve(listed)}
        restoreFromTrash={restore}
        onRestored={onRestored}
        revision={revision}
      />
    )
    const { rerender } = render(ui(1))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())

    listed = [row('d1', 'meeting-notes', 'Meeting notes')]
    rerender(ui(2))

    const toast = await screen.findByRole('status')
    expect(toast.textContent).toContain('Deleted Meeting notes')
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))

    await waitFor(() => expect(restore).toHaveBeenCalledWith('d1'))
    await waitFor(() => expect(onRestored).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
  })

  it('says nothing about documents that were already in the trash', async () => {
    render(
      <TrashSection
        listTrash={() => Promise.resolve([row('d1', 'old')])}
        restoreFromTrash={vi.fn()}
        onRestored={vi.fn()}
      />,
    )
    await screen.findByTestId('trash-section')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('counts a bulk delete and undoes all of it', async () => {
    let listed: readonly TrashRow[] = []
    const restore = vi.fn(() => Promise.resolve())
    const ui = (revision: number) => (
      <TrashSection
        listTrash={() => Promise.resolve(listed)}
        restoreFromTrash={restore}
        onRestored={vi.fn()}
        revision={revision}
      />
    )
    const { rerender } = render(ui(1))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    listed = [row('d1', 'a'), row('d2', 'b')]
    rerender(ui(2))

    expect((await screen.findByRole('status')).textContent).toContain('Deleted 2 documents')
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(2))
  })
})

describe('Trash rows on a coarse pointer', () => {
  it('give Restore, Delete permanently and the disclosure a 44px target', async () => {
    render(
      <TrashSection
        listTrash={() => Promise.resolve([row('d1', 'old')])}
        restoreFromTrash={vi.fn()}
        purgeFromTrash={vi.fn()}
        onRestored={vi.fn()}
      />,
    )
    const restore = await screen.findByRole('button', { name: 'Restore' })
    const purge = screen.getByRole('button', { name: 'Delete permanently' })
    const summary = screen.getByText(/^Trash \(/)
    for (const el of [restore, purge, summary]) {
      expect(el.className).toMatch(/pointer-coarse:min-h-11/)
    }
  })
})
