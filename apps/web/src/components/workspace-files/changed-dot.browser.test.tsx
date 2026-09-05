// The dot end to end in a REAL browser: a real open writes a real baseline
// to real localStorage, and the next mount compares a real listing against
// it. jsdom covers the rendering; what only this proves is that the two
// halves meet through storage the panel actually writes to.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { STORAGE_KEY } from '../../lib/seen-documents.js'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

let rows: WorkspaceDocumentEntry[] = []

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY)
  rows = [
    { documentId: 'd1', path: 'roadmap', name: 'Roadmap', kind: 'markdown', contentDigest: 'v1' },
    { documentId: 'd2', path: 'tokens', name: 'Tokens', kind: 'markdown', contentDigest: 'v1' },
  ]
})
afterEach(() => {
  cleanup()
  localStorage.removeItem(STORAGE_KEY)
})

function renderPanel() {
  render(
    <WorkspaceFilesPanel
      source={fakeFilesSource({ listDocuments: async () => rows })}
      workspace="space"
      onOpenDocument={() => {}}
    />,
  )
}

async function openCard(name: string) {
  const grid = await screen.findByTestId('folder-contents')
  const title = await within(grid).findByText(name)
  const card = title.closest('button')
  if (card === null) throw new Error(`no card for ${name}`)
  await userEvent.dblClick(card)
}

// Scoped to the GRID: once a document has been opened the recently-opened
// lane carries the same name, so an unscoped query is ambiguous exactly when
// the test has done its setup.
async function settle(name: string) {
  const grid = await screen.findByTestId('folder-contents')
  await within(grid).findByText(name)
}

const dotFor = (name: string) => {
  const title = screen.getAllByTestId('card-title').find((each) => each.textContent === name)
  const card = (title as HTMLElement).closest('button') as HTMLElement
  return within(card).queryByRole('img', { name: /changed since/i })
}

describe('changed since you last opened it', () => {
  it('says nothing about a document this device has never opened', async () => {
    renderPanel()
    await settle('Roadmap')

    expect(dotFor('Roadmap')).toBeNull()
  })

  it('stays silent when the content has not moved since the open', async () => {
    renderPanel()
    await openCard('Roadmap')
    cleanup()

    renderPanel()
    await settle('Roadmap')
    expect(dotFor('Roadmap')).toBeNull()
  })

  it('marks the document whose content moved while the person was elsewhere', async () => {
    renderPanel()
    await openCard('Roadmap')
    cleanup()

    // What an agent writing to the document looks like from here: the same
    // row comes back under a different content identity.
    rows = rows.map((row) => (row.path === 'roadmap' ? { ...row, contentDigest: 'v2' } : row))
    renderPanel()

    await waitFor(() => expect(dotFor('Roadmap')).not.toBeNull())
    // And only that one: the untouched neighbour was never opened, so it has
    // no baseline and must stay silent rather than read as changed.
    expect(dotFor('Tokens')).toBeNull()
  })

  it('clears once the person opens it again', async () => {
    renderPanel()
    await openCard('Roadmap')
    cleanup()
    rows = rows.map((row) => (row.path === 'roadmap' ? { ...row, contentDigest: 'v2' } : row))

    renderPanel()
    await waitFor(() => expect(dotFor('Roadmap')).not.toBeNull())
    await openCard('Roadmap')

    await waitFor(() => expect(dotFor('Roadmap')).toBeNull())
  })
})
