import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { WorkspaceTree } from './workspace-tree.js'

function makeTree(): { doc: LoroDoc; tree: WorkspaceTree } {
  const doc = new LoroDoc()
  return { doc, tree: new WorkspaceTree(doc) }
}

describe('WorkspaceTree', () => {
  it('creates a root node and retrieves it', () => {
    const { tree } = makeTree()
    const id = tree.createNode('canvas-1', 'my-canvas')
    const node = tree.getNode(id)
    expect(node).toBeDefined()
    expect(node!.canvasId).toBe('canvas-1')
    expect(node!.segment).toBe('my-canvas')
  })

  it('creates nested nodes and lists children', () => {
    const { tree } = makeTree()
    const parentId = tree.createNode('folder', 'projects')
    tree.createNode('c-1', 'alpha', parentId)
    tree.createNode('c-2', 'beta', parentId)

    const kids = tree.children(parentId)
    expect(kids).toHaveLength(2)
    expect(kids.map((k) => k.segment).sort()).toEqual(['alpha', 'beta'])
  })

  it('lists root-level nodes', () => {
    const { tree } = makeTree()
    tree.createNode('c-1', 'root-a')
    tree.createNode('c-2', 'root-b')
    const roots = tree.children()
    expect(roots).toHaveLength(2)
  })

  it('resolves alias from root to leaf', () => {
    const { tree } = makeTree()
    const folderId = tree.createNode('f', 'projects')
    const childId = tree.createNode('c', 'my-doc', folderId)
    expect(tree.resolveAlias(childId)).toBe('projects/my-doc')
  })

  it('resolves alias for a root node', () => {
    const { tree } = makeTree()
    const id = tree.createNode('c', 'root-only')
    expect(tree.resolveAlias(id)).toBe('root-only')
  })

  it('finds a node by alias path', () => {
    const { tree } = makeTree()
    const folderId = tree.createNode('f', 'docs')
    tree.createNode('c-readme', 'readme', folderId)

    const found = tree.findByAlias('docs/readme')
    expect(found).toBeDefined()
    expect(found!.canvasId).toBe('c-readme')
  })

  it('returns undefined for non-existent alias', () => {
    const { tree } = makeTree()
    expect(tree.findByAlias('no/such/path')).toBeUndefined()
  })

  it('renames a node segment', () => {
    const { tree } = makeTree()
    const id = tree.createNode('c', 'old-name')
    tree.rename(id, 'new-name')
    expect(tree.getNode(id)!.segment).toBe('new-name')
    expect(tree.resolveAlias(id)).toBe('new-name')
  })

  it('moves a node to a new parent', () => {
    const { tree } = makeTree()
    const a = tree.createNode('f-a', 'folder-a')
    const b = tree.createNode('f-b', 'folder-b')
    const child = tree.createNode('c', 'doc', a)

    tree.move(child, b)
    expect(tree.children(a)).toHaveLength(0)
    expect(tree.children(b)).toHaveLength(1)
    expect(tree.resolveAlias(child)).toBe('folder-b/doc')
  })

  it('deletes a node', () => {
    const { tree } = makeTree()
    const id = tree.createNode('c', 'to-delete')
    tree.delete(id)
    expect(tree.getNode(id)).toBeUndefined()
  })

  it('returns a snapshot of all nodes', () => {
    const { tree } = makeTree()
    tree.createNode('c-1', 'a')
    const b = tree.createNode('c-2', 'b')
    tree.createNode('c-3', 'child', b)

    const snap = tree.snapshot()
    expect(snap.nodes).toHaveLength(3)
  })

  describe('segment validation', () => {
    it('rejects empty segment', () => {
      const { tree } = makeTree()
      expect(() => tree.createNode('c', '')).toThrow('empty')
    })

    it('rejects segment with spaces', () => {
      const { tree } = makeTree()
      expect(() => tree.createNode('c', 'has space')).toThrow('Invalid segment')
    })

    it('rejects segment starting with hyphen', () => {
      const { tree } = makeTree()
      expect(() => tree.createNode('c', '-leading')).toThrow('Invalid segment')
    })

    it('accepts single character segment', () => {
      const { tree } = makeTree()
      const id = tree.createNode('c', 'a')
      expect(tree.getNode(id)!.segment).toBe('a')
    })
  })

  describe('sibling conflict', () => {
    it('rejects duplicate segment under same parent', () => {
      const { tree } = makeTree()
      tree.createNode('c-1', 'same-name')
      expect(() => tree.createNode('c-2', 'same-name')).toThrow('Sibling segment conflict')
    })

    it('allows same segment under different parents', () => {
      const { tree } = makeTree()
      const a = tree.createNode('f-a', 'folder-a')
      const b = tree.createNode('f-b', 'folder-b')
      tree.createNode('c-1', 'readme', a)
      tree.createNode('c-2', 'readme', b)
      expect(tree.children(a)).toHaveLength(1)
      expect(tree.children(b)).toHaveLength(1)
    })

    it('rejects rename to conflicting sibling', () => {
      const { tree } = makeTree()
      tree.createNode('c-1', 'taken')
      const id = tree.createNode('c-2', 'other')
      expect(() => tree.rename(id, 'taken')).toThrow('Sibling segment conflict')
    })

    it('rejects move to parent where segment already exists', () => {
      const { tree } = makeTree()
      const folder = tree.createNode('f', 'folder')
      tree.createNode('c-1', 'doc', folder)
      const outside = tree.createNode('c-2', 'doc')
      expect(() => tree.move(outside, folder)).toThrow('Sibling segment conflict')
    })
  })

  describe('CRDT merge', () => {
    it('merges two independent trees via snapshot import', () => {
      const { doc: doc1, tree: tree1 } = makeTree()
      tree1.createNode('c-1', 'from-peer-1')

      const { doc: doc2, tree: tree2 } = makeTree()
      tree2.createNode('c-2', 'from-peer-2')

      doc1.import(doc2.export({ mode: 'snapshot' }))
      const merged = new WorkspaceTree(doc1)
      const roots = merged.children()
      expect(roots).toHaveLength(2)
      expect(roots.map((r) => r.segment).sort()).toEqual(['from-peer-1', 'from-peer-2'])
    })
  })
})
