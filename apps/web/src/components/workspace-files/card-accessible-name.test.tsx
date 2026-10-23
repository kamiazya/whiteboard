// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { FolderContentsList } from './FolderContentsList.js'
import { RecentLane } from './RecentLane.js'
import { SearchResults } from './SearchResults.js'

afterEach(cleanup)

// A screen reader announces a document by what it is called and what kind it
// is. The body excerpt and the picture are supporting detail: reachable as a
// description, never the name.
const standup: WorkspaceDocumentEntry = {
  documentId: 'd1',
  path: 'notes/standup',
  name: 'Standup 22 Oct',
  kind: 'markdown',
  updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
  tags: ['weekly'],
}
const board: WorkspaceDocumentEntry = {
  documentId: 'd2',
  path: 'notes/board',
  kind: 'spatial',
}
const EXCERPT = 'Yesterday we shipped the thing and nobody noticed'

const picture = (entry: WorkspaceDocumentEntry) => (
  <span aria-hidden="true">{entry.documentId}</span>
)

describe('document card accessible name', () => {
  it('names a grid card by its label and kind', () => {
    render(
      <FolderContentsList
        documents={[standup, board]}
        folder="notes"
        onOpen={vi.fn()}
        renderThumbnail={picture}
      />,
    )
    expect(screen.getByRole('button', { name: 'Standup 22 Oct, Markdown note' })).toBeTruthy()
    // Unnamed: the leaf stand-in, same rule as the visible title.
    expect(screen.getByRole('button', { name: 'board, Canvas' })).toBeTruthy()
  })

  it('keeps pin and change state reachable as the card description', () => {
    render(
      <FolderContentsList
        documents={[{ ...standup, pinOrder: 0 }]}
        folder="notes"
        onOpen={vi.fn()}
        changed={new Set(['d1'])}
      />,
    )
    const card = screen.getByRole('button', { name: 'Standup 22 Oct, Markdown note' })
    const description = card.getAttribute('aria-describedby') ?? ''
    const text = description
      .split(' ')
      .map((id) => {
        const el = document.getElementById(id)
        return el?.getAttribute('aria-label') ?? el?.textContent ?? ''
      })
      .join(' ')
    expect(text).toContain('Pinned')
    expect(text).toContain('Changed since you last opened it')
    expect(text).toContain('#weekly')
  })

  it('names a Recent lane tile by its label and kind', () => {
    render(
      <RecentLane
        documents={[standup, board]}
        recentIds={['d1', 'd2']}
        onSelect={vi.fn()}
        onOpen={vi.fn()}
      />,
    )
    const lane = screen.getByRole('region', { name: /recent/i })
    expect(within(lane).getByRole('button', { name: 'Standup 22 Oct, Markdown note' })).toBeTruthy()
    expect(within(lane).getByRole('button', { name: 'board, Canvas' })).toBeTruthy()
  })

  it.each([
    'list',
    'grid',
  ] as const)('names a %s search result by its label and kind, not its excerpt', (layout) => {
    render(
      <SearchResults
        results={[{ document: standup, contexts: [EXCERPT], lexicalRank: 0 }]}
        query="shipped"
        onSelect={vi.fn()}
      />,
    )
    if (layout === 'grid') screen.getByRole('button', { name: 'Grid results' }).click()
    const row = screen.getByRole('button', { name: 'Standup 22 Oct, Markdown note' })
    const described = (row.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => {
        const el = document.getElementById(id)
        return el?.getAttribute('aria-label') ?? el?.textContent ?? ''
      })
      .join(' ')
    expect(described).toContain(EXCERPT)
  })

  it('names a folder card by the folder', () => {
    render(<FolderContentsList documents={[standup]} folder="" onOpen={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Open folder notes' })).toBeTruthy()
  })
})
