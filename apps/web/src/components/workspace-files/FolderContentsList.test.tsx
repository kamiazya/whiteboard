import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FolderContentsList } from './FolderContentsList.js'
import type { WorkspaceFileTreeDocument } from './WorkspaceFileTree.js'

const docs: WorkspaceFileTreeDocument[] = [
  { documentId: 'd1', path: 'design/login', name: 'Login', kind: 'markdown' },
  { documentId: 'd2', path: 'design/notes/kickoff', name: 'Kickoff', kind: 'markdown' },
  { documentId: 'd3', path: 'roadmap', name: 'Roadmap', kind: 'spatial' },
]

afterEach(cleanup)

describe('FolderContentsList', () => {
  it('lists one level: this folder’s documents and its child folders', () => {
    render(<FolderContentsList documents={docs} folder="design" onOpen={vi.fn()} />)

    const rows = screen.getAllByRole('listitem').map((li) => li.textContent)
    expect(rows).toEqual(['notes1', 'Login'])
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

  it('says the folder is empty rather than rendering an empty list', () => {
    render(<FolderContentsList documents={docs} folder="design/notes/kickoff" onOpen={vi.fn()} />)
    expect(screen.getByText(/empty/i).textContent).toMatch(/empty/i)
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('labels a document by its path segment when nobody named it', () => {
    const unnamed: WorkspaceFileTreeDocument[] = [{ documentId: 'd9', path: 'design/untitled-3' }]
    render(<FolderContentsList documents={unnamed} folder="design" onOpen={vi.fn()} />)
    expect(screen.getByRole('button', { name: /untitled-3/ }).textContent).toBe('untitled-3')
  })
})
