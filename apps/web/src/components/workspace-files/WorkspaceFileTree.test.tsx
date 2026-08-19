import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceFileTree } from './WorkspaceFileTree.js'

afterEach(cleanup)

const documents = [
  { documentId: 'c-root', path: 'readme' },
  { documentId: 'c-notes', path: 'notes' },
  { documentId: 'c-child', path: 'notes/design', name: 'Design system' },
  { documentId: 'c-deep', path: 'notes/design/palette' },
]

describe('WorkspaceFileTree', () => {
  // One column has no contents pane beside it, so the documents have to be
  // reachable from the column itself — the whole difference from the
  // folders-only sibling.
  it('shows documents at every depth, not only folders', () => {
    render(<WorkspaceFileTree documents={documents} onOpen={vi.fn()} />)
    expect(screen.getByText('readme')).not.toBeNull()
    expect(screen.getByText('palette')).not.toBeNull()
  })

  it('labels a document by its display name, not its path segment', () => {
    render(<WorkspaceFileTree documents={documents} onOpen={vi.fn()} />)
    expect(screen.getByText('Design system')).not.toBeNull()
    expect(screen.queryByText('design')).toBeNull()
  })

  it('reports the whole entry, so the preview needs no second lookup', () => {
    const onOpen = vi.fn()
    render(<WorkspaceFileTree documents={documents} onOpen={onOpen} />)

    fireEvent.click(screen.getByText('readme'))
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'c-root', path: 'readme' }),
    )
  })

  it('marks the document the preview is showing', () => {
    render(<WorkspaceFileTree documents={documents} onOpen={vi.fn()} selectedPath="readme" />)
    expect(screen.getByRole('button', { name: /readme/ }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: /palette/ }).getAttribute('aria-current')).toBeNull()
  })

  it('lets the caller supply a row’s picture', () => {
    render(
      <WorkspaceFileTree
        documents={documents}
        onOpen={vi.fn()}
        renderIcon={(doc) => <span data-testid="custom-icon">{doc.documentId}</span>}
      />,
    )
    expect(screen.getAllByTestId('custom-icon').length).toBe(documents.length)
  })

  it('keeps the kind icon when the caller supplies none', () => {
    render(
      <WorkspaceFileTree
        documents={[{ documentId: 'c1', path: 'a', name: 'Prose', kind: 'markdown' }]}
        onOpen={vi.fn()}
      />,
    )
    expect(
      screen
        .getByRole('treeitem', { name: 'Prose' })
        .querySelector('[data-kind]')
        ?.getAttribute('data-kind'),
    ).toBe('markdown')
  })

  // A folder that no document claims has no name of its own — the segment
  // is the honest label, and it is not something to click.
  it('shows a folder nobody claims as plain text', () => {
    render(
      <WorkspaceFileTree
        documents={[{ documentId: 'c1', path: 'design/login', name: 'Auth' }]}
        onOpen={vi.fn()}
      />,
    )
    expect(screen.getByText('design')).not.toBeNull()
    expect(screen.queryByRole('button', { name: /^design$/ })).toBeNull()
  })

  it('renders nested paths as an ARIA tree, not a flat list', () => {
    render(<WorkspaceFileTree documents={documents} onOpen={vi.fn()} />)
    expect(screen.getByRole('tree')).not.toBeNull()
    expect(screen.getByRole('treeitem', { name: /notes/ }).getAttribute('aria-expanded')).toBe(
      'true',
    )
    expect(screen.queryByText('notes/design')).toBeNull()
  })

  it('collapsing a branch hides its descendants', () => {
    render(<WorkspaceFileTree documents={documents} onOpen={vi.fn()} />)

    fireEvent.click(screen.getByTestId('tree-toggle-notes'))
    expect(screen.getByRole('treeitem', { name: /notes/ }).getAttribute('aria-expanded')).toBe(
      'false',
    )
    expect(screen.queryByText('Design system')).toBeNull()
    expect(screen.queryByText('palette')).toBeNull()
  })

  // `notes` is a document AND a folder: both halves have to work, or one of
  // the two roles becomes unreachable in this mode.
  it('a branch that is itself a document is both expandable and selectable', () => {
    const onOpen = vi.fn()
    render(<WorkspaceFileTree documents={documents} onOpen={onOpen} />)

    expect(screen.getByRole('treeitem', { name: /notes/ }).getAttribute('aria-expanded')).toBe(
      'true',
    )
    fireEvent.click(screen.getByText('notes'))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ path: 'notes' }))
  })

  it('shows an empty state instead of an empty tree', () => {
    render(<WorkspaceFileTree documents={[]} onOpen={vi.fn()} />)
    expect(screen.queryByRole('tree')).toBeNull()
    expect(screen.getByText(/no documents/i)).not.toBeNull()
  })
})
