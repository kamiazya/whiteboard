import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceFileTree } from './WorkspaceFileTree.js'

afterEach(cleanup)

const canvases = [
  { canvasId: 'c-root', segment: 'readme', alias: 'readme' },
  { canvasId: 'c-notes', segment: 'notes', alias: 'notes' },
  { canvasId: 'c-child', segment: 'design', alias: 'notes/design' },
  { canvasId: 'c-deep', segment: 'palette', alias: 'notes/design/palette' },
]

describe('WorkspaceFileTree', () => {
  it('renders nested aliases as an ARIA tree, not a flat list', () => {
    render(<WorkspaceFileTree canvases={canvases} onOpen={() => {}} />)

    expect(screen.getByRole('tree')).not.toBeNull()
    // notes is a branch: expandable, expanded by default.
    const notes = screen.getByRole('treeitem', { name: /notes/ })
    expect(notes.getAttribute('aria-expanded')).toBe('true')
    // Its child is reachable inside a group, not as a sibling alias string.
    expect(screen.getByRole('treeitem', { name: /design/ })).not.toBeNull()
    expect(screen.queryByText('notes/design')).toBeNull()
  })

  it('clicking a canvas row reports its canvasId', () => {
    const onOpen = vi.fn()
    render(<WorkspaceFileTree canvases={canvases} onOpen={onOpen} />)

    fireEvent.click(screen.getByText('readme'))
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ canvasId: 'c-root', alias: 'readme' }),
    )
  })

  it('collapsing a branch hides its descendants', () => {
    render(<WorkspaceFileTree canvases={canvases} onOpen={() => {}} />)

    fireEvent.click(screen.getByTestId('tree-toggle-notes'))
    expect(screen.getByRole('treeitem', { name: /notes/ }).getAttribute('aria-expanded')).toBe(
      'false',
    )
    expect(screen.queryByText('design')).toBeNull()
    expect(screen.queryByText('palette')).toBeNull()
  })

  it('a branch that is itself a canvas is both expandable and openable', () => {
    const onOpen = vi.fn()
    render(<WorkspaceFileTree canvases={canvases} onOpen={onOpen} />)

    // notes/design is a canvas AND has the child notes/design/palette.
    const design = screen.getByRole('treeitem', { name: /design/ })
    expect(design.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByText('design'))
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ canvasId: 'c-child', alias: 'notes/design' }),
    )
  })

  it('shows an empty state instead of an empty tree', () => {
    render(<WorkspaceFileTree canvases={[]} onOpen={() => {}} />)
    expect(screen.queryByRole('tree')).toBeNull()
    expect(screen.getByText(/no canvases/i)).not.toBeNull()
  })
})
