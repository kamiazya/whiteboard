/**
 * What a search result row must carry: the match, made visible.
 *
 * Prior-art survey (Finder, Explorer, VS Code, Obsidian, Dropbox, Notion,
 * Slack): highlighting the matched substring is near-universal in mature
 * search UIs, and the two surveyed apps WITHOUT per-row location context
 * (Finder, Figma) both have standing user complaints about it. This file pins
 * the two things that make a flat cross-workspace result list legible: the
 * highlighted match and the path on every row — plus the list/grid toggle.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceDocumentEntry } from './document-entry.js'
import { SearchResults } from './SearchResults.js'

afterEach(cleanup)

const documents: WorkspaceDocumentEntry[] = [
  { documentId: 'd1', path: 'plans/roadmap', name: 'Road map', kind: 'markdown' },
  { documentId: 'd2', path: 'sketches/map-of-rome', kind: 'spatial' },
]
// A row is the document plus why it is here; these cases are about the
// name and the path, so they carry no content excerpt.
const entries = documents.map((document) => ({ document }))

describe('SearchResults', () => {
  it('highlights the matched substring in the title', () => {
    render(<SearchResults results={entries} query="road" onSelect={vi.fn()} />)
    const marks = screen.getAllByTestId('search-match')
    // Case-insensitive, and in the TITLE — the visible answer to "why is
    // this row here".
    expect(marks.some((m) => m.textContent === 'Road')).toBe(true)
  })

  it('highlights a match that only the path has', () => {
    render(<SearchResults results={entries} query="rome" onSelect={vi.fn()} />)
    const marks = screen.getAllByTestId('search-match')
    expect(marks.some((m) => m.textContent === 'rome')).toBe(true)
  })

  it('offers a list/grid toggle and switches the layout', () => {
    render(<SearchResults results={entries} query="map" onSelect={vi.fn()} />)
    // List first: the row carries the path inline, which is the location
    // context a flat cross-workspace list owes every result.
    expect(screen.getByTestId('search-results-list')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Grid results' }))
    expect(screen.getByTestId('search-results-grid')).toBeTruthy()
    expect(screen.queryByTestId('search-results-list')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'List results' }))
    expect(screen.getByTestId('search-results-list')).toBeTruthy()
  })

  it('keeps the path visible on grid cards too', () => {
    // The Finder/Figma gap: flattening hierarchy without restoring location
    // per row is the documented complaint in both. The grid does not get to
    // reintroduce it.
    render(<SearchResults results={entries} query="map" onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Grid results' }))
    // By textContent, because the highlight splits the string across a
    // <mark> — which is itself the behaviour under test one case up.
    const grid = screen.getByTestId('search-results-grid')
    expect(grid.textContent).toContain('plans/roadmap')
  })
})
