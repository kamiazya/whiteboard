// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const entries = [
  { documentId: 'd1', path: 'notes/quota', name: 'Storage notes', kind: 'markdown' as const },
  { documentId: 'd2', path: 'plans/roadmap', name: 'Roadmap', kind: 'markdown' as const },
]

async function typeQuery(
  text: string,
  searchDocuments: (query: string) => Promise<never[] | { document: (typeof entries)[number] }[]>,
) {
  const source = fakeFilesSource({
    listDocuments: async () => entries,
    searchDocuments: searchDocuments as never,
  })
  render(<WorkspaceFilesPanel source={source} onOpenDocument={() => {}} />)
  await waitFor(() => expect(screen.getAllByTestId('card-title').length).toBeGreaterThan(0))
  fireEvent.change(screen.getByLabelText('Search documents'), { target: { value: text } })
}

describe('search announcement', () => {
  it('says how many results the settled query found', async () => {
    await typeQuery('map', async () => [{ document: entries[1] as (typeof entries)[number] }])
    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'Search results' }).textContent).toBe(
        '1 result for “map”',
      ),
    )
  })

  it('says no results when nothing matched', async () => {
    await typeQuery('zzz', async () => [])
    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'Search results' }).textContent).toBe(
        'No results for “zzz”',
      ),
    )
  })

  it('marks the results busy, then shows Searching… once the wait is noticeable', async () => {
    let release: (() => void) | undefined
    await typeQuery('map', () => new Promise((resolve) => (release = () => resolve([]))))
    const results = screen.getByTestId('search-results')
    expect(results.getAttribute('aria-busy')).toBe('true')
    expect(screen.queryByText('Searching…')).toBeNull()
    await waitFor(() => expect(screen.getByText('Searching…')).toBeTruthy(), { timeout: 2000 })
    await act(async () => release?.())
    await waitFor(() => expect(results.getAttribute('aria-busy')).not.toBe('true'))
    expect(screen.queryByText('Searching…')).toBeNull()
  })
})
