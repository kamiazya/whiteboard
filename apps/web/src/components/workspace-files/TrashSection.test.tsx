import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceCapacityReachedError } from '../../lib/browser-keeper-capacity.js'
import { TrashSection } from './TrashSection.js'
import { FolderNamesContext } from './use-folder-names.js'

afterEach(cleanup)

const rows = [{ documentId: 'd1', path: 'notes', deletedAt: Date.parse('2026-09-28T00:00:00Z') }]

function renderRefusing(err: Error) {
  render(
    <TrashSection
      listTrash={() => Promise.resolve(rows)}
      restoreFromTrash={vi.fn(() => Promise.reject(err))}
      onRestored={vi.fn()}
    />,
  )
}

describe('TrashSection', () => {
  it('says a restore into a full workspace was refused, and where to move it', async () => {
    renderRefusing(new WorkspaceCapacityReachedError(500))
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Settings > Connections/)
  })

  it('keeps the generic line for any other failure', async () => {
    renderRefusing(new Error('idb exploded'))
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Could not restore this document.')
  })
})

describe('where a trash row says the document was', () => {
  const deletedAt = Date.parse('2026-09-28T00:00:00Z')
  function renderRow(
    row: {
      documentId: string
      path: string
      name?: string
      deletedAt: number
      folderNames?: { path: string; name: string }[]
    },
    live: ReadonlyMap<string, string> = new Map(),
  ) {
    render(
      <FolderNamesContext.Provider value={live}>
        <TrashSection
          listTrash={() => Promise.resolve([row])}
          restoreFromTrash={vi.fn()}
          onRestored={vi.fn()}
        />
      </FolderNamesContext.Provider>,
    )
  }

  it('names a folder that went with the document by the name it had', async () => {
    renderRow({
      documentId: 'd1',
      path: 'field-trips/trip-log',
      name: 'Trip log',
      deletedAt,
      folderNames: [{ path: 'field-trips', name: 'Field trips' }],
    })
    expect(await screen.findByText(/^In Field trips ·/)).toBeTruthy()
  })

  it('names a folder that still stands by what it is called now', async () => {
    renderRow(
      {
        documentId: 'd1',
        path: 'field-trips/trip-log',
        deletedAt,
        folderNames: [{ path: 'field-trips', name: 'Field trips' }],
      },
      new Map([['field-trips', 'Outings']]),
    )
    expect(await screen.findByText(/^In Outings ·/)).toBeTruthy()
  })
})
