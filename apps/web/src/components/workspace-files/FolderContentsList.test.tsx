import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceDocumentEntry } from './document-entry.js'
import { FolderContentsList } from './FolderContentsList.js'

const docs: WorkspaceDocumentEntry[] = [
  { documentId: 'd1', path: 'design/login', name: 'Login', kind: 'markdown' },
  { documentId: 'd2', path: 'design/notes/kickoff', name: 'Kickoff', kind: 'markdown' },
  { documentId: 'd3', path: 'roadmap', name: 'Roadmap', kind: 'spatial' },
]

afterEach(cleanup)

describe('FolderContentsList', () => {
  it('lists one level: this folder’s documents and its child folders', () => {
    render(<FolderContentsList documents={docs} folder="design" onOpen={vi.fn()} />)

    const rows = screen.getAllByTestId('card-title').map((el) => el.textContent)
    expect(rows).toEqual(['notes', 'Login'])
  })

  it('opens a document by its entry and a folder by its path', () => {
    const onOpen = vi.fn()
    render(<FolderContentsList documents={docs} folder="design" onOpen={onOpen} />)

    fireEvent.click(screen.getByRole('button', { name: /Login/ }))
    expect(onOpen).toHaveBeenLastCalledWith({ kind: 'document', document: docs[0] })

    fireEvent.click(screen.getByRole('button', { name: 'Open folder notes' }))
    expect(onOpen).toHaveBeenLastCalledWith({ kind: 'folder', path: 'design/notes' })
  })

  it('marks the selected document so the preview and the list agree', () => {
    render(
      <FolderContentsList
        documents={docs}
        folder="design"
        onOpen={vi.fn()}
        selectedPath="design/login"
      />,
    )
    expect(screen.getByRole('button', { name: /Login/ }).getAttribute('aria-current')).toBe('true')
    expect(
      screen.getByRole('button', { name: 'Open folder notes' }).getAttribute('aria-current'),
    ).toBeNull()
  })

  // A contested path (two documents converged onto one address) is SHOWN,
  // never hidden: the badge is how the user learns a rename is needed —
  // resolution stays explicit, no silent auto-suffix.
  it('marks a shadowed document with a path-conflict badge', () => {
    const contested: WorkspaceDocumentEntry[] = [
      { documentId: 'own1', path: 'design', name: 'Owner', kind: 'spatial' },
      { documentId: 'riv1', path: 'design', name: 'Rival', kind: 'markdown', shadowed: true },
    ]
    render(<FolderContentsList documents={contested} folder="" onOpen={vi.fn()} />)
    const badges = screen.getAllByTestId('card-shadowed-badge')
    expect(badges).toHaveLength(1)
    expect(badges[0]?.textContent).toMatch(/path conflict/i)
  })

  it('renders no conflict badge for an uncontested document', () => {
    render(<FolderContentsList documents={docs} folder="design" onOpen={vi.fn()} />)
    expect(screen.queryByTestId('card-shadowed-badge')).toBeNull()
  })

  it('says the folder is empty rather than rendering an empty list', () => {
    render(<FolderContentsList documents={docs} folder="design/notes/kickoff" onOpen={vi.fn()} />)
    expect(screen.getByText(/empty/i).textContent).toMatch(/empty/i)
    expect(screen.queryByRole('list')).toBeNull()
  })

  // The capability slot: this component never fetches or renders a
  // document, so the miniature has to arrive from the caller. It is the only
  // thing that distinguishes one row from another at a glance, and nothing
  // above this component notices when it stops arriving.
  it('draws the caller’s miniature instead of the kind icon', () => {
    render(
      <FolderContentsList
        documents={docs}
        folder="design"
        onOpen={vi.fn()}
        renderThumbnail={(doc) => <span data-testid="custom-icon">{doc.documentId}</span>}
      />,
    )
    expect(screen.getByTestId('custom-icon').textContent).toBe('d1')
    expect(document.querySelector('[data-kind]')).toBeNull()
  })

  it('falls back to the kind, which the list already carries', () => {
    render(<FolderContentsList documents={docs} folder="" onOpen={vi.fn()} />)
    expect(
      screen
        .getByRole('button', { name: /Roadmap/ })
        .querySelector('[data-kind]')
        ?.getAttribute('data-kind'),
    ).toBe('spatial')
  })

  // The card carries the folder's own count, which is what makes a folder
  // worth clicking into rather than a guess.
  it('says how much is inside a folder', () => {
    render(<FolderContentsList documents={docs} folder="design" onOpen={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Open folder notes' }).textContent).toContain('1')
  })

  // The card says what the document is and how stale it is — the two things
  // a name alone cannot tell you when forty of them are on screen.
  it('says a document’s kind and age on its card', () => {
    const dated: WorkspaceDocumentEntry[] = [
      {
        documentId: 'd1',
        path: 'design/login',
        name: 'Login',
        kind: 'markdown',
        updatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      },
    ]
    render(<FolderContentsList documents={dated} folder="design" onOpen={vi.fn()} />)
    // The subtitle specifically: the placeholder standing in for a missing
    // thumbnail also prints the kind, so asserting on the whole card would
    // pass with the subtitle saying nothing at all.
    expect(screen.getByTestId('card-subtitle').textContent).toBe('markdown · 2d ago')
  })

  // A daemon that does not record the time must not make the card say
  // something false about it.
  it('carries no age when the daemon did not record one', () => {
    render(<FolderContentsList documents={docs} folder="design" onOpen={vi.fn()} />)
    expect(screen.getAllByTestId('card-subtitle')[0]?.textContent).toBe('markdown')
  })

  it('labels a document by its path segment when nobody named it', () => {
    const unnamed: WorkspaceDocumentEntry[] = [{ documentId: 'd9', path: 'design/untitled-3' }]
    render(<FolderContentsList documents={unnamed} folder="design" onOpen={vi.fn()} />)
    expect(screen.getByTestId('card-title').textContent).toBe('untitled-3')
  })
})
