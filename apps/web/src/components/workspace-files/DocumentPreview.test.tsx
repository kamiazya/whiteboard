import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { DocumentPreview } from './DocumentPreview.js'

afterEach(cleanup)

const doc: WorkspaceDocumentEntry = {
  documentId: 'd1',
  path: 'design/login',
  name: 'Login flow',
  kind: 'markdown',
  updatedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
}
const drawn = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300"><rect/></svg>',
  bounds: { x: 0, y: 0, w: 400, h: 300 },
}

describe('DocumentPreview', () => {
  it('says nothing is selected rather than showing an empty frame', () => {
    render(<DocumentPreview document={null} loadRender={vi.fn()} />)
    expect(screen.getByText(/Select a document/)).not.toBeNull()
  })

  // Explicit resolution of a contested path: the preview names the
  // conflict beside the one control that fixes it (Rename), instead of a
  // silent auto-suffix nobody chose.
  it('explains a shadowed document next to the Rename control', async () => {
    const shadowed: WorkspaceDocumentEntry = { ...doc, shadowed: true }
    render(
      <DocumentPreview document={shadowed} loadRender={async () => drawn} onRename={vi.fn()} />,
    )
    await act(async () => {})
    expect(screen.getByTestId('preview-shadowed-notice').textContent).toMatch(
      /another document owns this path/i,
    )
  })

  it('shows no conflict notice for an uncontested document', async () => {
    render(<DocumentPreview document={doc} loadRender={async () => drawn} onRename={vi.fn()} />)
    await act(async () => {})
    expect(screen.queryByTestId('preview-shadowed-notice')).toBeNull()
  })

  // The pane draws the document. It used to pour the OKF source into a
  // <pre>, which showed the file — frontmatter and all — and showed nothing
  // whatsoever for a spatial document.
  it('draws the document rather than printing its source', async () => {
    const loadRender = vi.fn(async () => drawn)
    render(<DocumentPreview document={doc} loadRender={loadRender} />)

    await act(async () => {})

    const svg = screen.getByTestId('preview-render').querySelector('svg')
    expect(svg?.getAttribute('viewBox')).toBe('0 0 400 300')
    expect(svg?.getAttribute('width')).toBeNull()
    expect(screen.queryByText(/^---$/)).toBeNull()
  })

  it('carries the name, the path and the age beside the drawing', async () => {
    render(<DocumentPreview document={doc} loadRender={async () => drawn} />)
    await act(async () => {})

    expect(screen.getByRole('heading').textContent).toBe('Login flow')
    expect(screen.getByText('design/login')).not.toBeNull()
    expect(screen.getByText('3d ago')).not.toBeNull()
  })

  // A document that will not draw is still a document — losing its name and
  // path too would turn a blank picture into a blank pane.
  // 'settled with nothing' and 'still drawing' look the same if you only
  // check that no drawing is present — assert which of the two it says, or a
  // pane that never leaves the loading state passes as handled failure.
  it('keeps the document’s details when it cannot be drawn', async () => {
    render(<DocumentPreview document={doc} loadRender={async () => null} />)
    await act(async () => {})

    expect(screen.queryByTestId('preview-render')).toBeNull()
    expect(screen.getByText('Nothing to draw yet.')).not.toBeNull()
    expect(screen.getByRole('heading').textContent).toBe('Login flow')
  })

  it('keeps them when the render throws outright', async () => {
    render(
      <DocumentPreview
        document={doc}
        loadRender={async () => {
          throw new Error('offline')
        }}
      />,
    )
    await act(async () => {})

    expect(screen.queryByTestId('preview-render')).toBeNull()
    expect(screen.getByText('Nothing to draw yet.')).not.toBeNull()
    expect(screen.getByRole('heading').textContent).toBe('Login flow')
  })

  // Looking is not opening: browsing a folder must not keep throwing someone
  // into an editor, so the way in is an explicit control.
  it('opens only when asked, and never on being previewed', async () => {
    const onOpen = vi.fn()
    render(<DocumentPreview document={doc} loadRender={async () => drawn} onOpen={onOpen} />)
    await act(async () => {})

    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(onOpen).toHaveBeenCalledWith(doc)
  })

  // A reply for the document that WAS selected must not paint over the one
  // selected since — the pane would then show one document's picture under
  // another's name.
  it('drops a render that arrives after the selection moved on', async () => {
    let settleFirst: (r: typeof drawn) => void = () => {}
    const loadRender = vi.fn((entry: WorkspaceDocumentEntry) =>
      entry.path === 'design/login'
        ? new Promise<typeof drawn>((resolve) => {
            settleFirst = resolve
          })
        : Promise.resolve({ ...drawn, svg: drawn.svg.replace('400 300', '11 11') }),
    )
    const other: WorkspaceDocumentEntry = {
      documentId: 'd2',
      path: 'design/other',
      kind: 'markdown',
    }

    const { rerender } = render(<DocumentPreview document={doc} loadRender={loadRender} />)
    rerender(<DocumentPreview document={other} loadRender={loadRender} />)
    await act(async () => {
      settleFirst(drawn)
    })

    expect(screen.getByTestId('preview-render').querySelector('svg')?.getAttribute('viewBox')).toBe(
      '0 0 11 11',
    )
  })

  // The path is where a document LIVES. Editing it — and the display name
  // beside it — belongs to the Rename dialog, which is the one surface that
  // explains how the two differ; this pane only opens it.
  describe('renaming a document', () => {
    it('asks the caller to open the rename dialog for THIS document', async () => {
      const onRename = vi.fn()
      render(<DocumentPreview document={doc} loadRender={async () => drawn} onRename={onRename} />)
      await act(async () => {})
      fireEvent.click(screen.getByRole('button', { name: /Rename/ }))
      expect(onRename).toHaveBeenCalledWith(doc)
    })

    it('has no rename affordance when the caller supplies no way to rename', async () => {
      render(<DocumentPreview document={doc} loadRender={async () => drawn} />)
      await act(async () => {})
      expect(screen.queryByRole('button', { name: /Rename/ })).toBeNull()
    })
  })

  // The grid had a Duplicate and a Delete on every card; the browser has to
  // carry them or retiring the grid loses them. They live on the SELECTED
  // document, which is the one the pane is already about.
  describe('acting on the selected document', () => {
    it('duplicates, and does not open or rename anything', async () => {
      const onDuplicate = vi.fn()
      const onOpen = vi.fn()
      render(
        <DocumentPreview
          document={doc}
          loadRender={async () => drawn}
          onOpen={onOpen}
          onDuplicate={onDuplicate}
        />,
      )
      await act(async () => {})

      fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))
      expect(onDuplicate).toHaveBeenCalledWith(doc)
      expect(onOpen).not.toHaveBeenCalled()
    })

    // Destructive, so the pane never performs it — it asks, and the caller
    // owns the confirmation. A pane that deleted on click would be one
    // mis-aimed pointer away from losing a subtree.
    it('asks to delete rather than deleting', async () => {
      const onDelete = vi.fn()
      render(<DocumentPreview document={doc} loadRender={async () => drawn} onDelete={onDelete} />)
      await act(async () => {})

      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
      expect(onDelete).toHaveBeenCalledWith(doc)
    })

    it('offers neither when the caller supplies neither', async () => {
      render(<DocumentPreview document={doc} loadRender={async () => drawn} />)
      await act(async () => {})
      expect(screen.queryByRole('button', { name: 'Duplicate' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
    })
  })
})

describe('kind row and action icons', () => {
  const entry = (kind: 'markdown' | 'spatial') => ({
    documentId: 'd1',
    path: 'note',
    name: 'Note',
    kind,
  })
  const noopLoad = async () => null

  // Kills the inverted-ternary mutant: the icon must FOLLOW the kind.
  it('the Kind row draws the icon of the kind on screen', () => {
    render(<DocumentPreview document={entry('spatial')} loadRender={noopLoad} />)
    expect(screen.getByTestId('preview-kind-icon').getAttribute('data-kind')).toBe('spatial')
    cleanup()
    render(<DocumentPreview document={entry('markdown')} loadRender={noopLoad} />)
    expect(screen.getByTestId('preview-kind-icon').getAttribute('data-kind')).toBe('markdown')
  })

  it('each action button carries its own icon, not a shared or shuffled one', () => {
    render(
      <DocumentPreview
        document={entry('markdown')}
        loadRender={noopLoad}
        onOpen={() => {}}
        onDuplicate={() => {}}
        onDelete={() => {}}
      />,
    )
    const iconIn = (name: string) =>
      screen.getByRole('button', { name }).querySelector('svg')?.getAttribute('class') ?? ''
    expect(iconIn('Open')).toContain('lucide-external-link')
    expect(iconIn('Duplicate')).toContain('lucide-copy-plus')
    expect(iconIn('Delete')).toContain('lucide-trash-2')
  })
})
