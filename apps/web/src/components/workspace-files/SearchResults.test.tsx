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
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { SearchResults } from './SearchResults.js'
import { FolderNamesContext } from './use-folder-names.js'

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
    expect(screen.getAllByTestId('result-location').map((each) => each.textContent)).toEqual([
      'plans',
      'sketches',
    ])
    expect(grid.textContent).not.toContain('plans/roadmap')
  })

  it('highlights the accented original for an unaccented query', () => {
    const cafe = [
      { document: { documentId: 'c', path: 'suppliers/list', name: 'Café supplier list' } },
    ]
    render(<SearchResults results={cafe} query="cafe" onSelect={vi.fn()} />)
    expect(screen.getAllByTestId('search-match').map((m) => m.textContent)).toContain('Café')
  })

  it('says where a result is by its folders’ display names, not by its address', () => {
    const names = new Map([
      ['folder', '文献レビュー'],
      ['folder/deep-learning', '深層学習'],
    ])
    const rows = [
      { document: { documentId: 'n', path: 'folder/deep-learning/nmt', name: '機械翻訳' } },
      { document: { documentId: 'r', path: 'quipe-ops/untitled-8' } },
    ]
    render(
      <FolderNamesContext.Provider value={names}>
        <SearchResults results={rows} query="翻訳" onSelect={vi.fn()} />
      </FolderNamesContext.Provider>,
    )
    expect(screen.getAllByTestId('result-title').map((each) => each.textContent)).toEqual([
      '機械翻訳',
      'Untitled 8',
    ])
    expect(screen.getAllByTestId('result-location').map((each) => each.textContent)).toEqual([
      '文献レビュー / 深層学習',
      'quipe-ops',
    ])
    expect(screen.getByTestId('search-results-list').textContent).not.toContain('folder/deep')
  })

  it('places a document at the top of the workspace under the workspace', () => {
    const rows = [{ document: { documentId: 't', path: 'todo', name: 'Todo' } }]
    render(<SearchResults results={rows} query="todo" onSelect={vi.fn()} />)
    expect(screen.getByTestId('result-location').textContent).toBe('Workspace')
  })
})
