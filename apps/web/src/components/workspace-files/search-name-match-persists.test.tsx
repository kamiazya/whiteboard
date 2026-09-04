// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

// A row that is on screen and then vanishes is worse than one that never
// appeared: it says the document was found and then unfound. That is what
// the panel did while someone typed — names and paths answer the first
// keystroke, and the content answer replaced them wholesale a moment later,
// dropping every document only its NAME matched.

afterEach(cleanup)

const entries = [
  { documentId: 'd1', path: 'notes/quota', name: 'Storage notes', kind: 'markdown' as const },
  { documentId: 'd2', path: 'plans/roadmap', name: 'Roadmap', kind: 'markdown' as const },
]

async function search(text: string) {
  await waitFor(() => expect(screen.getAllByTestId('card-title').length).toBeGreaterThan(0))
  fireEvent.change(screen.getByLabelText('Search documents'), { target: { value: text } })
}

describe('a name match survives the content answer', () => {
  it('still lists the document a prefix names once the content hits arrive', async () => {
    // The content search answers with a DIFFERENT document, which is both
    // the realistic case and the trigger this test needs: its excerpt is
    // how we know the answer landed rather than assuming the debounce ran.
    const source = fakeFilesSource({
      listDocuments: async () => entries,
      searchDocuments: async () => [
        { document: entries[0] as (typeof entries)[number], contexts: ['…roa…'] },
      ],
    })
    render(<WorkspaceFilesPanel source={source} onOpenDocument={() => {}} />)

    // "roa" is a prefix of "Roadmap", so the name filter finds it and the
    // word-token search structurally cannot.
    await search('roa')
    // Titles carry the match marked in place, so they are read whole rather
    // than matched as one text node.
    const titles = () =>
      within(screen.getByTestId('search-results'))
        .queryAllByTestId('result-title')
        .map((el) => el.textContent)
    expect(titles()).toContain('Roadmap')

    // The trigger: the content answer is now on screen.
    await screen.findByTestId('result-excerpt')
    expect(titles()).toContain('Storage notes')
    // The outcome: the name match did not vanish under it.
    expect(titles()).toContain('Roadmap')
  })
})
