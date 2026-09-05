// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { RecentLane } from './RecentLane.js'

// The lane is an ADDITION beside the grid, never a reordering of it: the grid
// is sorted by path, and a person's memory of where a card sat is worth more
// than putting the newest first (NN/g). So the lane's own order is recency
// and the grid below it does not move.

afterEach(cleanup)

const entry = (over: Partial<WorkspaceDocumentEntry>): WorkspaceDocumentEntry => ({
  documentId: 'd1',
  path: 'design/login',
  name: 'Login',
  kind: 'markdown',
  ...over,
})

const documents = [
  entry({ documentId: 'd1', path: 'design/login', name: 'Login' }),
  entry({ documentId: 'd2', path: 'design/board', name: 'Board', kind: 'spatial' }),
  entry({ documentId: 'd3', path: 'notes/scratch', name: 'Scratch' }),
]

describe('RecentLane', () => {
  it('lists the recorded documents in recency order, not the listing order', () => {
    render(<RecentLane documents={documents} recentIds={['d3', 'd1']} onOpen={() => {}} />)

    const lane = screen.getByRole('region', { name: /recent/i })
    expect(
      within(lane)
        .getAllByRole('button')
        .map((each) => each.textContent),
    ).toEqual(['Scratch', 'Login'])
  })

  it('renders nothing at all when nothing has been recorded', () => {
    render(<RecentLane documents={documents} recentIds={[]} onOpen={() => {}} />)

    expect(screen.queryByRole('region', { name: /recent/i })).toBeNull()
  })

  it('drops a recorded id the listing no longer holds, rather than showing a dead tile', () => {
    // A deleted document — the lane resolves against the listing already in
    // hand, so it needs no reconciliation pass of its own.
    render(<RecentLane documents={documents} recentIds={['gone', 'd2']} onOpen={() => {}} />)

    const lane = screen.getByRole('region', { name: /recent/i })
    expect(within(lane).getAllByRole('button')).toHaveLength(1)
    expect(within(lane).getByRole('button').textContent).toBe('Board')
  })

  it('renders nothing when every recorded id has gone', () => {
    render(<RecentLane documents={documents} recentIds={['gone', 'also-gone']} onOpen={() => {}} />)

    expect(screen.queryByRole('region', { name: /recent/i })).toBeNull()
  })

  it('opens the entry it was given, not one looked up by path', () => {
    const onOpen = vi.fn()
    render(<RecentLane documents={documents} recentIds={['d2']} onOpen={onOpen} />)

    fireEvent.click(screen.getByRole('button', { name: /Board/ }))

    expect(onOpen).toHaveBeenCalledWith(documents[1])
  })

  it('shows the path tail when a document was never named', () => {
    render(
      <RecentLane
        documents={[entry({ documentId: 'd9', path: 'notes/untitled-2', name: undefined })]}
        recentIds={['d9']}
        onOpen={() => {}}
      />,
    )

    expect(screen.getByRole('button').textContent).toBe('untitled-2')
  })

  it('draws each tile through the thumbnail renderer it is given', () => {
    render(
      <RecentLane
        documents={documents}
        recentIds={['d1', 'd2']}
        onOpen={() => {}}
        renderThumbnail={(each) => <span data-testid={`thumb-${each.documentId}`} />}
      />,
    )

    expect(screen.getByTestId('thumb-d1')).toBeTruthy()
    expect(screen.getByTestId('thumb-d2')).toBeTruthy()
  })
})
