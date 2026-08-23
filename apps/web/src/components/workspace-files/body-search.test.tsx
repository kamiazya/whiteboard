// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

// The search box asks the SOURCE, so it finds what a name-and-path filter
// cannot: a word that appears only in a document's body.

afterEach(cleanup)

const entries = [
  { documentId: 'd1', path: 'notes/quota', name: 'Storage notes', kind: 'markdown' as const },
  { documentId: 'd2', path: 'plans/roadmap', name: 'Roadmap', kind: 'markdown' as const },
]

function renderPanel(overrides: Parameters<typeof fakeFilesSource>[0] = {}) {
  const source = fakeFilesSource({ listDocuments: async () => entries, ...overrides })
  render(<WorkspaceFilesPanel source={source} onOpenDocument={() => {}} />)
  return source
}

async function search(text: string) {
  await waitFor(() => expect(screen.getAllByTestId('card-title').length).toBeGreaterThan(0))
  fireEvent.change(screen.getByLabelText('Search documents'), { target: { value: text } })
}

describe('body search', () => {
  it('lists a document whose BODY matched, with the excerpt that explains why', async () => {
    renderPanel({
      searchDocuments: async () => [
        {
          document: entries[1] as (typeof entries)[number],
          contexts: ['…the quota exceeded error shows up on save…'],
        },
      ],
    })
    await search('quota')

    // The answer is asynchronous by design (the source reads content), so
    // the row arrives after the debounce rather than with the keystroke.
    const excerpt = await screen.findByTestId('result-excerpt')
    const results = screen.getByTestId('search-results')
    // The row is the body match — not the path that happens to say "quota".
    expect(within(results).getByText('Roadmap')).toBeTruthy()
    expect(excerpt.textContent).toContain('quota exceeded')
    // …with the query marked inside it, the same way titles are.
    expect(within(excerpt).getAllByTestId('search-match')[0]?.textContent?.toLowerCase()).toBe(
      'quota',
    )
  })

  it('asks the source, not the loaded list', async () => {
    const source = renderPanel({ searchDocuments: async () => [] })
    await search('anything')
    await waitFor(() => expect(source.searchDocuments).toHaveBeenCalledWith('anything', 20))
  })

  it('says what it searched when nothing matched', async () => {
    renderPanel({ searchDocuments: async () => [] })
    await search('存在しない語')

    const results = await screen.findByTestId('search-results')
    // Not a bare "nothing matches": lexical search cannot cross languages,
    // so the empty state must not read as "this document does not exist".
    expect(results.textContent).toContain('存在しない語')
    expect(results.textContent).toMatch(/names, paths and contents/i)
  })

  it('never lets a slower answer for an older query win', async () => {
    let release: ((hits: never[]) => void) | undefined
    const source = fakeFilesSource({
      listDocuments: async () => entries,
      searchDocuments: async (query: string) => {
        if (query === 'slow') return new Promise<never[]>((resolve) => (release = resolve))
        return [{ document: entries[0] as (typeof entries)[number], contexts: ['fast answer'] }]
      },
    })
    render(<WorkspaceFilesPanel source={source} onOpenDocument={() => {}} />)

    await search('slow')
    fireEvent.change(screen.getByLabelText('Search documents'), { target: { value: 'fast' } })
    await waitFor(() =>
      expect(screen.getByTestId('search-results').textContent).toContain('fast answer'),
    )

    release?.([])
    // The stale empty answer must not replace the newer one.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.getByTestId('search-results').textContent).toContain('fast answer')
  })
})
