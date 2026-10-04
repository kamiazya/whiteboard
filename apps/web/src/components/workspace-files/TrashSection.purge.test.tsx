// @vitest-environment jsdom
/**
 * Delete permanently, from the Trash: a confirmed, per-document action that
 * the section offers only when its source can purge.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DESTRUCTIVE_COPY } from '../../lib/destructive-copy.js'
import type { TrashRow } from '../../lib/files-source.js'
import { TrashSection } from './TrashSection.js'

afterEach(cleanup)

const ENTRY: TrashRow = { documentId: 'd1', path: 'old/plan', deletedAt: 1_700_000 }

function renderSection(purgeFromTrash: ((documentId: string) => Promise<void>) | undefined) {
  let rows: readonly TrashRow[] = [ENTRY]
  const purge = purgeFromTrash
  render(
    <TrashSection
      listTrash={() => Promise.resolve(rows)}
      restoreFromTrash={vi.fn(async () => undefined)}
      {...(purge === undefined
        ? {}
        : {
            purgeFromTrash: async (documentId: string) => {
              await purge(documentId)
              rows = rows.filter((row) => row.documentId !== documentId)
            },
          })}
      onRestored={vi.fn()}
    />,
  )
}

async function openPurgeDialog() {
  fireEvent.click(await screen.findByText(/^Trash/))
  fireEvent.click(await screen.findByRole('button', { name: 'Delete permanently' }))
  return screen.findByRole('alertdialog')
}

describe('TrashSection permanent delete', () => {
  it('offers no such action when the source cannot purge', async () => {
    renderSection(undefined)
    fireEvent.click(await screen.findByText(/^Trash/))
    await screen.findByText('old/plan')

    expect(screen.queryByRole('button', { name: 'Delete permanently' })).toBeNull()
  })

  it('asks first, in the declared words, and purges nothing until confirmed', async () => {
    const purge = vi.fn(async () => undefined)
    renderSection(purge)

    const dialog = await openPurgeDialog()

    expect(within(dialog).getByText(DESTRUCTIVE_COPY['purge-trash-entry']('old/plan'))).toBeTruthy()
    expect(purge).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(purge).not.toHaveBeenCalled()
    expect(screen.getByText('old/plan')).toBeTruthy()
  })

  it('purges the named document on confirm, and the row leaves the section', async () => {
    const purge = vi.fn(async () => undefined)
    renderSection(purge)

    const dialog = await openPurgeDialog()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }))

    await waitFor(() => expect(purge).toHaveBeenCalledWith('d1'))
    await waitFor(() => expect(screen.queryByText('old/plan')).toBeNull())
  })

  it('says it failed in the dialog and keeps the choice open, instead of closing as if done', async () => {
    renderSection(
      vi.fn(async () => {
        throw new Error('404')
      }),
    )

    const dialog = await openPurgeDialog()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }))

    expect(await within(dialog).findByText('Could not delete this document.')).toBeTruthy()
    expect(screen.getByRole('alertdialog')).toBeTruthy()
  })
})
