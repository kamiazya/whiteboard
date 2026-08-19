import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceFolderTree } from './WorkspaceFolderTree.js'

afterEach(cleanup)

const documents = [
  { documentId: 'c-root', path: 'readme' },
  { documentId: 'c-notes', path: 'notes' },
  { documentId: 'c-child', path: 'notes/design' },
  { documentId: 'c-deep', path: 'notes/design/palette' },
]

describe('WorkspaceFolderTree', () => {
  // The whole reason this pane exists beside the contents pane: it answers
  // WHERE, not what. Listing documents made the two near-duplicates.
  it('lists folders only — no document ever appears', () => {
    render(<WorkspaceFolderTree documents={documents} onSelectFolder={() => {}} />)

    expect(screen.getByText('notes')).not.toBeNull()
    expect(screen.getByText('design')).not.toBeNull()
    // Documents at every depth: a top-level one, and a leaf under two folders.
    expect(screen.queryByText('readme')).toBeNull()
    expect(screen.queryByText('palette')).toBeNull()
  })

  // `notes` is a document AND a folder. It is a folder here because
  // something lives under it; its document half belongs to the pane that
  // lists its parent.
  it('shows a path that is both a document and a folder', () => {
    render(<WorkspaceFolderTree documents={documents} onSelectFolder={() => {}} />)
    expect(screen.getByRole('treeitem', { name: 'notes' })).not.toBeNull()
  })

  it('reports the prefix, which is a folder’s only identity', () => {
    const onSelectFolder = vi.fn()
    render(<WorkspaceFolderTree documents={documents} onSelectFolder={onSelectFolder} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open folder design' }))
    expect(onSelectFolder).toHaveBeenCalledWith('notes/design')
  })

  // Every document at the top level, so there is no folder at all — the root
  // must still be reachable or the pane beside this one has no destination.
  it('offers the root even when the workspace is flat', () => {
    const onSelectFolder = vi.fn()
    render(
      <WorkspaceFolderTree
        documents={[{ documentId: 'c1', path: 'readme' }]}
        onSelectFolder={onSelectFolder}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open folder Workspace' }))
    expect(onSelectFolder).toHaveBeenCalledWith('')
    expect(screen.queryByText('readme')).toBeNull()
  })

  it('marks the folder the pane beside it is showing', () => {
    render(
      <WorkspaceFolderTree
        documents={documents}
        onSelectFolder={() => {}}
        selectedFolder="notes/design"
      />,
    )
    expect(
      screen.getByRole('button', { name: 'Open folder design' }).getAttribute('aria-current'),
    ).toBe('true')
    expect(
      screen.getByRole('button', { name: 'Open folder notes' }).getAttribute('aria-current'),
    ).toBeNull()
  })

  it('renders nesting as an ARIA tree, not a flat list of prefixes', () => {
    render(<WorkspaceFolderTree documents={documents} onSelectFolder={() => {}} />)

    expect(screen.getByRole('tree')).not.toBeNull()
    expect(screen.getByRole('treeitem', { name: 'notes' }).getAttribute('aria-expanded')).toBe(
      'true',
    )
    expect(screen.queryByText('notes/design')).toBeNull()
  })

  it('collapsing a branch hides its descendants', () => {
    render(<WorkspaceFolderTree documents={documents} onSelectFolder={() => {}} />)

    fireEvent.click(screen.getByTestId('tree-toggle-notes'))
    expect(screen.getByRole('treeitem', { name: 'notes' }).getAttribute('aria-expanded')).toBe(
      'false',
    )
    expect(screen.queryByText('design')).toBeNull()
  })

  // A folder holding only documents has nothing to expand, but is still a
  // destination — the expander is what disappears, not the row.
  it('keeps a leaf folder selectable and gives it no expander', () => {
    render(
      <WorkspaceFolderTree
        documents={[{ documentId: 'c1', path: 'inbox/triage' }]}
        onSelectFolder={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: 'Open folder inbox' })).not.toBeNull()
    expect(screen.getByRole('treeitem', { name: 'inbox' }).getAttribute('aria-expanded')).toBeNull()
  })
})
