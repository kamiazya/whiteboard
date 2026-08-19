import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentPreview } from './DocumentPreview.js'
import type { WorkspaceDocumentEntry } from './document-entry.js'

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

  // The path is where a document LIVES, and until now the only way to change
  // it was an HTTP route with no caller. This is that caller.
  describe('moving a document', () => {
    async function open() {
      const onMove = vi.fn(async () => undefined)
      render(<DocumentPreview document={doc} loadRender={async () => drawn} onMove={onMove} />)
      await act(async () => {})
      fireEvent.click(screen.getByRole('button', { name: /Move/ }))
      return onMove
    }

    it('offers the current path as the starting point', async () => {
      await open()
      expect(screen.getByRole('textbox', { name: /path/i })).toHaveProperty('value', 'design/login')
    })

    it('moves the document to the typed path', async () => {
      const onMove = await open()
      fireEvent.change(screen.getByRole('textbox', { name: /path/i }), {
        target: { value: 'archive/login' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(onMove).toHaveBeenCalledWith(doc, 'archive/login'))
    })

    // Saving the path it already has is not a move — it is a round trip that
    // can only fail (the destination is occupied by the document itself).
    it('does nothing when the path was not changed', async () => {
      const onMove = await open()
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await act(async () => {})
      expect(onMove).not.toHaveBeenCalled()
    })

    // The server names the PRODUCED path that collided, which on a subtree
    // move is often not the one that was typed. Showing our own sentence
    // would send someone to retry the one thing that was never the problem.
    it('shows the server’s own refusal, not a rebuilt one', async () => {
      render(
        <DocumentPreview
          document={doc}
          loadRender={async () => drawn}
          onMove={async () => {
            throw new Error('Path "archive/login/notes" already exists')
          }}
        />,
      )
      await act(async () => {})
      fireEvent.click(screen.getByRole('button', { name: /Move/ }))
      fireEvent.change(screen.getByRole('textbox', { name: /path/i }), {
        target: { value: 'archive/login' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))

      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toContain('archive/login/notes')
    })

    it('has no move affordance when the caller supplies no way to move', async () => {
      render(<DocumentPreview document={doc} loadRender={async () => drawn} />)
      await act(async () => {})
      expect(screen.queryByRole('button', { name: /Move/ })).toBeNull()
    })
  })
})
