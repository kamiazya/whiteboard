import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceCapacityReachedError } from '../../lib/browser-keeper-capacity.js'
import { TrashSection } from './TrashSection.js'

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
