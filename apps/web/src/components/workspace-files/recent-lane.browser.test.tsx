// The recently-opened lane end to end in a REAL browser: a real click on a
// real card, a real localStorage write, and the lane on the next mount. jsdom
// covers the lane's own rendering; what only a browser proves is that the two
// halves meet through storage the panel actually writes to.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { STORAGE_KEY } from '../../lib/recent-documents.js'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

const entries = [
  { documentId: 'd1', path: 'meeting-notes', name: 'Meeting notes', kind: 'markdown' as const },
  { documentId: 'd2', path: 'roadmap', name: 'Roadmap', kind: 'spatial' as const },
]

beforeEach(() => localStorage.removeItem(STORAGE_KEY))
afterEach(() => {
  cleanup()
  localStorage.removeItem(STORAGE_KEY)
})

// No default parameter: a default fires on an EXPLICIT undefined too, so
// `renderPanel(undefined)` would have rendered the 'space' workspace and the
// no-handle case would have tested nothing.
function renderPanel(workspace: string | undefined) {
  const source = fakeFilesSource({ listDocuments: async () => entries })
  render(<WorkspaceFilesPanel source={source} workspace={workspace} onOpenDocument={() => {}} />)
}

async function openCard(name: string) {
  // Scoped to the grid: once the lane exists it holds the same names, so an
  // unscoped query is ambiguous exactly when the feature is working.
  const grid = await screen.findByTestId('folder-contents')
  const title = await within(grid).findByText(name)
  const card = title.closest('button')
  if (card === null) throw new Error(`no card for ${name}`)
  // A fine pointer selects on click and opens on double-click, which is the
  // desktop half of the wayfinding contract slice 1 established.
  await userEvent.dblClick(card)
}

const lane = () => screen.queryByTestId('recent-lane')

describe('recently opened lane', () => {
  it('is absent until something has been opened', async () => {
    renderPanel('space')
    await screen.findByText('Meeting notes')

    expect(lane()).toBeNull()
  })

  it('carries what was opened to the next mount, newest first', async () => {
    renderPanel('space')
    await openCard('Meeting notes')
    await openCard('Roadmap')
    cleanup()

    renderPanel('space')
    const strip = await screen.findByTestId('recent-lane')
    await waitFor(() =>
      expect(
        within(strip)
          .getAllByRole('button')
          .map((each) => each.textContent),
      ).toEqual(['Roadmap', 'Meeting notes']),
    )
  })

  it('keeps one entry per document however often it is reopened', async () => {
    renderPanel('space')
    await openCard('Roadmap')
    await openCard('Meeting notes')
    await openCard('Roadmap')
    cleanup()

    renderPanel('space')
    const strip = await screen.findByTestId('recent-lane')
    await waitFor(() => expect(within(strip).getAllByRole('button')).toHaveLength(2))
    expect(within(strip).getAllByRole('button')[0]?.textContent).toBe('Roadmap')
  })

  it('steps aside while a search is showing its own answer', async () => {
    renderPanel('space')
    await openCard('Roadmap')
    await screen.findByTestId('recent-lane')

    await userEvent.fill(screen.getByLabelText('Search documents'), 'meeting')

    await waitFor(() => expect(lane()).toBeNull())
  })

  it('does not carry one workspace lane into another', async () => {
    renderPanel('alpha')
    await openCard('Roadmap')
    cleanup()

    renderPanel('beta')
    await screen.findByText('Meeting notes')
    expect(lane()).toBeNull()
  })

  it('stays absent for a host that passes no workspace handle', async () => {
    renderPanel(undefined)
    await openCard('Roadmap')
    cleanup()

    renderPanel(undefined)
    await screen.findByText('Meeting notes')
    expect(lane()).toBeNull()
  })
})
