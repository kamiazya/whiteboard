import { describe, expect, it } from 'vitest'
import { folderContents } from './folder-contents.js'

const docs = [
  { documentId: 'r', path: 'readme', kind: 'markdown' as const },
  { documentId: 'd1', path: 'design/login', name: 'Auth signup flow', kind: 'spatial' as const },
  { documentId: 'd2', path: 'design/onboarding', kind: 'spatial' as const },
  { documentId: 'd3', path: 'design/notes/palette', kind: 'markdown' as const },
  { documentId: 'a1', path: 'architecture/overview', kind: 'markdown' as const },
]

describe('folderContents', () => {
  it('lists what sits directly at the root, folders included', () => {
    const { folders, documents } = folderContents(docs, '')
    expect(folders.map((f) => f.path)).toEqual(['architecture', 'design'])
    expect(documents.map((d) => d.path)).toEqual(['readme'])
  })

  // The middle pane shows one level. A grandchild belongs to the folder
  // between them, not here — that is the whole difference from a flat list.
  it('does not reach past one level', () => {
    const { folders, documents } = folderContents(docs, 'design')
    expect(folders.map((f) => f.path)).toEqual(['design/notes'])
    expect(documents.map((d) => d.path)).toEqual(['design/login', 'design/onboarding'])
  })

  it('counts what a folder holds, at every depth below it', () => {
    const { folders } = folderContents(docs, '')
    expect(folders.find((f) => f.path === 'design')?.count).toBe(3)
  })

  it('names a folder by its own segment, which is all it has', () => {
    const { folders } = folderContents(docs, 'design')
    expect(folders[0]?.name).toBe('notes')
  })

  // A document can be an interior segment: `design` could itself be a
  // document while `design/login` exists. It is then BOTH, and the pane has
  // to show it in both roles rather than picking one.
  it('shows a document that is also a folder in both roles', () => {
    const withBoth = [...docs, { documentId: 'd0', path: 'design', kind: 'markdown' as const }]
    const { folders, documents } = folderContents(withBoth, '')
    expect(folders.map((f) => f.path)).toContain('design')
    expect(documents.map((d) => d.path)).toContain('design')
  })

  // Looking INSIDE `design` when `design` is itself a document: the document
  // is not its own child, and counting it would put an entry in the pane
  // that is the folder the user is already standing in.
  it('does not list the folder’s own document as a child of itself', () => {
    const withBoth = [...docs, { documentId: 'd0', path: 'design', kind: 'markdown' as const }]
    const { folders, documents } = folderContents(withBoth, 'design')
    expect(documents.map((d) => d.path)).toEqual(['design/login', 'design/onboarding'])
    expect(folders.map((f) => f.path)).toEqual(['design/notes'])
  })

  it('answers empty for a folder nothing lives in', () => {
    expect(folderContents(docs, 'nowhere')).toEqual({ folders: [], documents: [] })
  })

  // A sibling that merely shares the prefix is not inside it.
  it('does not treat a name-prefix sibling as a child', () => {
    const { documents } = folderContents(
      [
        { documentId: 'x', path: 'design/a', kind: 'markdown' as const },
        { documentId: 'y', path: 'design-system/b', kind: 'markdown' as const },
      ],
      'design',
    )
    expect(documents.map((d) => d.path)).toEqual(['design/a'])
  })

  it('orders folders before documents, each by name', () => {
    const { folders, documents } = folderContents(docs, '')
    expect(folders.map((f) => f.name)).toEqual(['architecture', 'design'])
    expect(documents.map((d) => d.path)).toEqual(['readme'])
  })
})

describe('folderContents pinned order', () => {
  // The grid this pane replaced put pinned documents first (in the order the
  // user pinned them), and retiring it must not silently lose that. Unpinned
  // documents keep the path order; pinned ones step in front of it.
  it('lists pinned documents first, in pinOrder, ahead of the path sort', () => {
    const pinnable = [
      { documentId: 'a', path: 'design/alpha' },
      { documentId: 'z', path: 'design/zeta', pinOrder: 0 },
      { documentId: 'm', path: 'design/mid', pinOrder: 1 },
      { documentId: 'b', path: 'design/beta' },
    ]
    const { documents } = folderContents(pinnable, 'design')
    expect(documents.map((d) => d.path)).toEqual([
      'design/zeta',
      'design/mid',
      'design/alpha',
      'design/beta',
    ])
  })
})
