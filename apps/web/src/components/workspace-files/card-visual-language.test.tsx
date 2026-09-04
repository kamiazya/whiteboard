// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceDocumentEntry } from './document-entry.js'
import { FolderContentsList } from './FolderContentsList.js'

// The card's visual language (slice 2 of the 2026-09-05 picker redesign):
// kind is an ICON — the same FileText/LayoutGrid vocabulary the tree rows
// already speak — not a word in the subtitle, and a pinned document says so
// ON the card instead of only through its sort position. The subtitle
// carries only the relative age, and disappears with it.

afterEach(cleanup)

const dated = (over: Partial<WorkspaceDocumentEntry>): WorkspaceDocumentEntry => ({
  documentId: 'd1',
  path: 'design/login',
  name: 'Login',
  kind: 'markdown',
  updatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  ...over,
})

describe('card kind badge', () => {
  it('marks kind with an icon carrying an accessible name, per kind', () => {
    render(
      <FolderContentsList
        documents={[
          dated({}),
          dated({ documentId: 'd2', path: 'design/board', name: 'Board', kind: 'spatial' }),
        ]}
        folder="design"
        onOpen={vi.fn()}
      />,
    )
    const kindOf = (title: string) => {
      const card = screen
        .getAllByTestId('card-title')
        .find((el) => el.textContent === title)
        ?.closest('button') as HTMLElement
      return within(card).getByTestId('card-kind-badge')
    }
    expect(kindOf('Login').getAttribute('data-kind')).toBe('markdown')
    expect(kindOf('Board').getAttribute('data-kind')).toBe('spatial')
    // The word left the subtitle; the icon must still ANSWER for the kind.
    expect(kindOf('Login').getAttribute('aria-label')).toBe('markdown')
    expect(kindOf('Board').getAttribute('aria-label')).toBe('spatial')
  })

  it('the subtitle is the age alone', () => {
    render(<FolderContentsList documents={[dated({})]} folder="design" onOpen={vi.fn()} />)
    expect(screen.getByTestId('card-subtitle').textContent).toBe('2d ago')
  })

  it('no age, no subtitle — the kind icon already says the rest', () => {
    const { documentId, path, name, kind } = dated({})
    render(
      <FolderContentsList
        documents={[{ documentId, path, name, kind }]}
        folder="design"
        onOpen={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('card-subtitle')).toBeNull()
    expect(screen.getByTestId('card-kind-badge').getAttribute('data-kind')).toBe('markdown')
  })
})

describe('card pin marker', () => {
  it('a pinned document says so on the card', () => {
    render(
      <FolderContentsList
        documents={[
          dated({ pinOrder: 0 }),
          dated({ documentId: 'd2', path: 'design/loose', name: 'Loose' }),
        ]}
        folder="design"
        onOpen={vi.fn()}
      />,
    )
    const cards = screen
      .getAllByTestId('card-title')
      .map((el) => el.closest('button') as HTMLElement)
    expect(within(cards[0] as HTMLElement).getByLabelText('Pinned')).toBeTruthy()
    expect(within(cards[1] as HTMLElement).queryByLabelText('Pinned')).toBeNull()
  })
})
