// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { FolderContentsList } from './FolderContentsList.js'

// The dot answers "did this change while I was not looking", which is a
// different question from the age text beside it and does not replace it.
// Binary on purpose: an unread badge needs no legend, where a freshness
// gradient would have to teach its own mapping.

afterEach(cleanup)

const entry = (over: Partial<WorkspaceDocumentEntry>): WorkspaceDocumentEntry => ({
  documentId: 'd1',
  path: 'roadmap',
  name: 'Roadmap',
  kind: 'markdown',
  updatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  contentDigest: 'digest-now',
  ...over,
})

const documents = [
  entry({ documentId: 'd1', path: 'roadmap', name: 'Roadmap' }),
  entry({ documentId: 'd2', path: 'tokens', name: 'Tokens' }),
]

const cardFor = (name: string) => {
  const title = screen.getAllByTestId('card-title').find((each) => each.textContent === name)
  return (title as HTMLElement).closest('button') as HTMLElement
}

const dotIn = (name: string) => within(cardFor(name)).queryByRole('img', { name: /changed since/i })

describe('the changed dot', () => {
  it('marks a document the set names, and only that one', () => {
    render(
      <FolderContentsList
        documents={documents}
        folder=""
        onOpen={() => {}}
        changed={new Set(['d2'])}
      />,
    )

    expect(dotIn('Tokens')).toBeTruthy()
    expect(dotIn('Roadmap')).toBeNull()
  })

  it('marks nothing when the set is empty, which is what a fresh device shows', () => {
    render(
      <FolderContentsList documents={documents} folder="" onOpen={() => {}} changed={new Set()} />,
    )

    expect(dotIn('Roadmap')).toBeNull()
    expect(dotIn('Tokens')).toBeNull()
  })

  it('marks nothing at all when the caller passes no set', () => {
    render(<FolderContentsList documents={documents} folder="" onOpen={() => {}} />)

    expect(dotIn('Roadmap')).toBeNull()
  })

  it('carries a text alternative, so nothing is said by colour alone', () => {
    render(
      <FolderContentsList
        documents={documents}
        folder=""
        onOpen={() => {}}
        changed={new Set(['d1'])}
      />,
    )

    expect(dotIn('Roadmap')?.getAttribute('aria-label')).toMatch(
      /changed since you last opened it/i,
    )
  })

  it('leaves the age text in place beside it — the two answer different questions', () => {
    render(
      <FolderContentsList
        documents={documents}
        folder=""
        onOpen={() => {}}
        changed={new Set(['d1'])}
      />,
    )

    expect(within(cardFor('Roadmap')).getByText('2d ago')).toBeTruthy()
  })
})
