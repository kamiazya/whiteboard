import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceFileTree } from './WorkspaceFileTree.js'

afterEach(cleanup)

const documents = [
  { documentId: 'c-root', path: 'readme' },
  { documentId: 'c-notes', path: 'notes' },
  { documentId: 'c-child', path: 'notes/design' },
  { documentId: 'c-deep', path: 'notes/design/palette' },
]

describe('WorkspaceFileTree', () => {
  // The name is what every other surface shows and what a reference resolves
  // by; the path is an auto-generated address nothing invites you to type.
  // Showing the segment made the tree the one place a document went by a
  // different name than the rest of the app calls it.
  it('labels a document by its display name, not its path segment', () => {
    render(
      <WorkspaceFileTree
        documents={[{ documentId: 'c1', path: 'design/login-flow', name: 'Auth signup flow' }]}
        onOpen={() => {}}
      />,
    )
    expect(screen.getByText('Auth signup flow')).not.toBeNull()
    expect(screen.queryByText('login-flow')).toBeNull()
  })

  // The list carries the kind, so the row shows it. Not the minimap that
  // will replace this icon — just the difference between the two things a
  // document can be, which the tree already knows and was throwing away.
  it('distinguishes a spatial document from a markdown one', () => {
    render(
      <WorkspaceFileTree
        documents={[
          { documentId: 'c1', path: 'a', name: 'Prose', kind: 'markdown' },
          { documentId: 'c2', path: 'b', name: 'Diagram', kind: 'spatial' },
        ]}
        onOpen={() => {}}
      />,
    )
    const prose = screen.getByRole('treeitem', { name: 'Prose' })
    const diagram = screen.getByRole('treeitem', { name: 'Diagram' })
    expect(prose.querySelector('[data-kind]')?.getAttribute('data-kind')).toBe('markdown')
    expect(diagram.querySelector('[data-kind]')?.getAttribute('data-kind')).toBe('spatial')
  })

  // A capability slot, like DocumentListView's renderThumb: the tree never
  // fetches or renders a document itself, so it stays usable by a caller
  // that has no daemon to fetch from.
  it('lets the caller supply a row’s icon', () => {
    render(
      <WorkspaceFileTree
        documents={[{ documentId: 'c1', path: 'a', name: 'Prose', kind: 'markdown' }]}
        onOpen={() => {}}
        renderIcon={(doc) => <span data-testid="custom-icon">{doc.documentId}</span>}
      />,
    )
    expect(screen.getByTestId('custom-icon').textContent).toBe('c1')
  })

  it('keeps the kind icon when the caller supplies none', () => {
    render(
      <WorkspaceFileTree
        documents={[{ documentId: 'c1', path: 'a', name: 'Prose', kind: 'markdown' }]}
        onOpen={() => {}}
      />,
    )
    expect(
      screen.getByRole('treeitem', { name: 'Prose' }).querySelector('[data-kind]'),
    ).not.toBeNull()
  })

  it('falls back to the segment for a document nobody named', () => {
    render(
      <WorkspaceFileTree
        documents={[{ documentId: 'c1', path: 'design/untitled-2' }]}
        onOpen={() => {}}
      />,
    )
    expect(screen.getByText('untitled-2')).not.toBeNull()
  })

  // A folder has no document and therefore no name of its own — only the
  // segment, which is the honest label for it.
  it('still labels a folder by its segment', () => {
    render(
      <WorkspaceFileTree
        documents={[{ documentId: 'c1', path: 'design/login', name: 'Auth signup flow' }]}
        onOpen={() => {}}
      />,
    )
    expect(screen.getByText('design')).not.toBeNull()
  })

  it('renders nested paths as an ARIA tree, not a flat list', () => {
    render(<WorkspaceFileTree documents={documents} onOpen={() => {}} />)

    expect(screen.getByRole('tree')).not.toBeNull()
    // notes is a branch: expandable, expanded by default.
    const notes = screen.getByRole('treeitem', { name: /notes/ })
    expect(notes.getAttribute('aria-expanded')).toBe('true')
    // Its child is reachable inside a group, not as a sibling path string.
    expect(screen.getByRole('treeitem', { name: /design/ })).not.toBeNull()
    expect(screen.queryByText('notes/design')).toBeNull()
  })

  it('clicking a canvas row reports its documentId', () => {
    const onOpen = vi.fn()
    render(<WorkspaceFileTree documents={documents} onOpen={onOpen} />)

    fireEvent.click(screen.getByText('readme'))
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'c-root', path: 'readme' }),
    )
  })

  it('collapsing a branch hides its descendants', () => {
    render(<WorkspaceFileTree documents={documents} onOpen={() => {}} />)

    fireEvent.click(screen.getByTestId('tree-toggle-notes'))
    expect(screen.getByRole('treeitem', { name: /notes/ }).getAttribute('aria-expanded')).toBe(
      'false',
    )
    expect(screen.queryByText('design')).toBeNull()
    expect(screen.queryByText('palette')).toBeNull()
  })

  it('a branch that is itself a canvas is both expandable and openable', () => {
    const onOpen = vi.fn()
    render(<WorkspaceFileTree documents={documents} onOpen={onOpen} />)

    // notes/design is a canvas AND has the child notes/design/palette.
    const design = screen.getByRole('treeitem', { name: /design/ })
    expect(design.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByText('design'))
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'c-child', path: 'notes/design' }),
    )
  })

  it('shows an empty state instead of an empty tree', () => {
    render(<WorkspaceFileTree documents={[]} onOpen={() => {}} />)
    expect(screen.queryByRole('tree')).toBeNull()
    expect(screen.getByText(/no documents/i)).not.toBeNull()
  })
})
