import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
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
