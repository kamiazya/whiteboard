import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { TagInUse } from '../../lib/files-source.js'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

const DOCS = [
  {
    documentId: 'A',
    path: 'release-plan',
    name: 'Release plan',
    kind: 'markdown' as const,
    tags: ['release', 'q3'],
  },
  { documentId: 'B', path: 'retro', name: 'Retro', kind: 'markdown' as const, tags: ['q3'] },
  { documentId: 'C', path: 'misc', name: 'Misc', kind: 'markdown' as const },
]

function renderPanel() {
  return render(
    <WorkspaceFilesPanel
      source={fakeFilesSource({ listDocuments: () => Promise.resolve(DOCS) })}
    />,
  )
}

describe('tag filter strip', () => {
  it('lists each workspace tag once and filters on click; clicking again clears', async () => {
    renderPanel()
    const strip = await screen.findByRole('group', { name: /filter by tag/i })
    const release = screen.getByRole('button', { name: '#release' })
    expect(strip.textContent).toContain('#q3')

    fireEvent.click(release)
    // The search box carries the filter, so it is visible, editable state.
    expect(screen.getByRole('searchbox', { name: /search documents/i })).toHaveProperty(
      'value',
      '#release',
    )
    await waitFor(() => {
      expect(screen.queryByText('Misc')).toBeNull()
      expect(screen.getByText('Release plan')).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: '#release' }))
    expect(screen.getByRole('searchbox', { name: /search documents/i })).toHaveProperty('value', '')
    await waitFor(() => {
      expect(screen.getByText('Misc')).toBeTruthy()
    })
  })

  it('renders no strip when nothing is tagged', async () => {
    render(
      <WorkspaceFilesPanel
        source={fakeFilesSource({
          listDocuments: () =>
            Promise.resolve([{ documentId: 'C', path: 'misc', kind: 'markdown' as const }]),
        })}
      />,
    )
    await screen.findByText('misc')
    expect(screen.queryByRole('group', { name: /filter by tag/i })).toBeNull()
  })

  it('shows presentational tag chips on document cards', async () => {
    renderPanel()
    const card = (await screen.findByText('Release plan')).closest('button')
    expect(card?.textContent).toContain('#release')
    expect(card?.textContent).toContain('#q3')
  })
})

describe('search result rows', () => {
  it('a #tag hit shows the tag that put it in the results', async () => {
    renderPanel()
    fireEvent.change(await screen.findByRole('searchbox', { name: /search documents/i }), {
      target: { value: '#q3' },
    })
    const list = await screen.findByTestId('search-results-list')
    expect(list.textContent).toContain('Release plan')
    expect(list.textContent).toContain('#q3')
    expect(list.textContent).not.toContain('Misc')
  })
})

describe('tag filter strip from the keeper’s vocabulary', () => {
  it('groups a scoped key’s values under the key and counts every bearer, when the source answers', async () => {
    render(
      <WorkspaceFilesPanel
        source={fakeFilesSource({
          listDocuments: () => Promise.resolve(DOCS),
          listTagsInUse: () =>
            Promise.resolve([
              {
                tag: 'health:ok',
                key: 'health',
                value: 'ok',
                documents: 0,
                boards: 1,
                nodes: 2,
                edges: 0,
              },
              { tag: 'release', documents: 1, boards: 0, nodes: 0, edges: 0 },
            ]),
        })}
      />,
    )
    const strip = await screen.findByRole('group', { name: /filter by tag/i })
    await waitFor(() => expect(screen.getByRole('button', { name: '#health:ok' })).toBeTruthy())
    expect(strip.textContent).toContain('health')
    // A tag only the entries know (q3) is not on the strip: the keeper's
    // answer is the vocabulary, and the entries were only the fallback.
    expect(screen.queryByRole('button', { name: '#q3' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '#health:ok' }))
    expect(screen.getByRole('searchbox', { name: /search documents/i })).toHaveProperty(
      'value',
      '#health:ok',
    )
  })
})

describe('a chip the strip counted from boxes', () => {
  // The strip counts what boxes and edges carry; a press on such a chip
  // filters by `#tag`, and the board has to be what that finds.
  it('finds the board carrying it when pressed', async () => {
    render(
      <WorkspaceFilesPanel
        source={fakeFilesSource({
          listDocuments: () =>
            Promise.resolve([
              ...DOCS,
              {
                documentId: 'D',
                path: 'boards/uptime',
                name: 'Uptime board',
                kind: 'spatial' as const,
                carriedTags: ['health:ok'],
              },
            ]),
          listTagsInUse: () =>
            Promise.resolve([
              {
                tag: 'health:ok',
                key: 'health',
                value: 'ok',
                documents: 0,
                boards: 0,
                nodes: 2,
                edges: 0,
              },
            ]),
        })}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: '#health:ok' }))
    const list = await screen.findByTestId('search-results-list')
    expect(list.textContent).toContain('Uptime board')
    expect(list.textContent).not.toContain('Release plan')
  })
})

describe('the strip’s rows', () => {
  // Two effects ask for the rows — the workspace load and a revision bump —
  // and the earlier ask can answer last. Its rows are from before the write
  // that bumped the revision, so they must not land.
  it('land only from the latest ask, whatever order the answers arrive in', async () => {
    const answers: Array<(rows: readonly TagInUse[]) => void> = []
    const source = fakeFilesSource({
      listDocuments: () => Promise.resolve(DOCS),
      listTagsInUse: () =>
        new Promise<readonly TagInUse[]>((resolve) => {
          answers.push(resolve)
        }),
    })
    const { rerender } = render(<WorkspaceFilesPanel source={source} />)
    await waitFor(() => expect(answers).toHaveLength(1))
    rerender(<WorkspaceFilesPanel source={source} revision={1} />)
    await waitFor(() => expect(answers).toHaveLength(2))
    answers[1]?.([{ tag: 'after', documents: 1, boards: 0, nodes: 0, edges: 0 }])
    await screen.findByRole('button', { name: '#after' })
    answers[0]?.([{ tag: 'before', documents: 1, boards: 0, nodes: 0, edges: 0 }])
    // Only a stale answer could add a chip now; give it every chance to.
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^#/ })).toHaveLength(1))
    expect(screen.queryByRole('button', { name: '#before' })).toBeNull()
    expect(screen.getByRole('button', { name: '#after' })).toBeTruthy()
  })
})
