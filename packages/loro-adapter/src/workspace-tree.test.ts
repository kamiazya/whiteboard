/**
 * The workspace tree: one Loro document holding every document a workspace
 * contains, as nodes of a `LoroTree`.
 *
 * What is pinned here is the part a type cannot carry — that placement, naming
 * and content are ONE convergent structure, and what that structure does when
 * two peers disagree. The CRDT answers those questions itself; this file is
 * where the answers are written down so a later change cannot quietly pick
 * different ones.
 */
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { readSpatialCanvas, writeSpatialCanvas } from './loro-bridge.js'
import {
  adoptWorkspaceDocument,
  createWorkspaceDocument,
  createWorkspaceDocumentAtPath,
  deleteWorkspaceDocument,
  documentContainers,
  moveWorkspaceDocument,
  projectWorkspaceDocument,
  readWorkspaceDocuments,
  resolveWorkspaceDocument,
  resolveWorkspaceDocumentById,
  setWorkspaceDocumentName,
} from './workspace-tree.js'

const ID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const ID_B = '01BX5ZZKBKACTAV9WEVGEMMVRZ'
const ID_C = '01CX5ZZKBKACTAV9WEVGEMMVRZ'

function workspace(): LoroDoc {
  const doc = new LoroDoc()
  doc.setPeerId(1n)
  return doc
}

describe('workspace tree', () => {
  it('derives a path from where a document sits, not from a stored string', () => {
    const doc = workspace()
    const design = createWorkspaceDocument(doc, {
      documentId: ID_A,
      segment: 'design',
      kind: 'spatial',
    })
    createWorkspaceDocument(doc, {
      documentId: ID_B,
      segment: 'notes',
      kind: 'markdown',
      parentId: design.documentId,
    })

    expect(readWorkspaceDocuments(doc).map((entry) => entry.path)).toEqual([
      'design',
      'design/notes',
    ])
  })

  it('carries descendants with a move, because a path is its ancestors', () => {
    const doc = workspace()
    const design = createWorkspaceDocument(doc, {
      documentId: ID_A,
      segment: 'design',
      kind: 'spatial',
    })
    createWorkspaceDocument(doc, {
      documentId: ID_B,
      segment: 'notes',
      kind: 'markdown',
      parentId: design.documentId,
    })
    const archive = createWorkspaceDocument(doc, {
      documentId: ID_C,
      segment: 'archive',
      kind: 'spatial',
    })

    moveWorkspaceDocument(doc, { documentId: ID_A, parentId: archive.documentId })

    expect(readWorkspaceDocuments(doc).map((entry) => entry.path)).toEqual([
      'archive',
      'archive/design',
      'archive/design/notes',
    ])
  })

  it('keeps a document reachable by id after it moves', () => {
    const doc = workspace()
    createWorkspaceDocument(doc, { documentId: ID_A, segment: 'design', kind: 'spatial' })
    const archive = createWorkspaceDocument(doc, {
      documentId: ID_B,
      segment: 'archive',
      kind: 'spatial',
    })
    moveWorkspaceDocument(doc, { documentId: ID_A, parentId: archive.documentId })

    // The share link names the id, so this is what stops a move breaking one.
    expect(resolveWorkspaceDocumentById(doc, ID_A)?.path).toBe('archive/design')
  })

  it('holds a document’s content inside its own node', () => {
    const doc = workspace()
    createWorkspaceDocument(doc, { documentId: ID_A, segment: 'design', kind: 'spatial' })
    createWorkspaceDocument(doc, { documentId: ID_B, segment: 'other', kind: 'spatial' })

    writeSpatialCanvas(documentContainers(doc, ID_A), {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 80, height: 40, text: 'hello' }],
      edges: [],
    })

    expect(readSpatialCanvas(documentContainers(doc, ID_A)).nodes).toHaveLength(1)
    // The neighbour is untouched: content lives in the node, so two documents
    // in one Loro document cannot read each other's containers.
    expect(readSpatialCanvas(documentContainers(doc, ID_B)).nodes).toEqual([])
  })

  it('renames without moving', () => {
    const doc = workspace()
    createWorkspaceDocument(doc, { documentId: ID_A, segment: 'design', kind: 'spatial' })
    setWorkspaceDocumentName(doc, { documentId: ID_A, name: 'Design System' })

    const entry = resolveWorkspaceDocumentById(doc, ID_A)
    expect(entry?.name).toBe('Design System')
    // The address does not move when the label does.
    expect(entry?.path).toBe('design')
  })

  describe('undo/redo on a tree-hosted document', () => {
    it('a READ between undo and redo does not clear the redo stack', async () => {
      // On a tree node, attaching a container is an op. Before containers
      // were pre-attached at creation, undoing a node-create detached the
      // `nodes` map, the next READ re-attached it via getOrCreateContainer —
      // a local op — and that op cleared the redo stack: create → undo →
      // read → redo left the document empty. This is the page's exact flow
      // (undo publishes a canvas read before redo can be clicked).
      const { UndoManager } = await import('loro-crdt')
      const ws = workspace()
      createWorkspaceDocumentAtPath(ws, { path: 'design', documentId: ID_A, kind: 'spatial' })
      ws.commit()

      const doc = new LoroDoc()
      doc.import(ws.export({ mode: 'snapshot' }))
      const undoManager = new UndoManager(doc, { mergeInterval: 500 })

      writeSpatialCanvas(documentContainers(doc, ID_A), {
        nodes: [{ id: 'n-1', type: 'text', x: 0, y: 0, width: 80, height: 40, text: 'probe' }],
        edges: [],
      })
      expect(undoManager.canUndo()).toBe(true)
      undoManager.undo()
      // The read that used to consume the redo.
      expect(readSpatialCanvas(documentContainers(doc, ID_A)).nodes).toHaveLength(0)

      expect(undoManager.canRedo()).toBe(true)
      undoManager.redo()
      expect(readSpatialCanvas(documentContainers(doc, ID_A)).nodes).toHaveLength(1)
    })
  })

  describe('projecting a document back out as a standalone Loro document', () => {
    it('adopt → project round-trips the content, and node meta scalars stay out of the roots', () => {
      const standalone = new LoroDoc()
      standalone.setPeerId(9n)
      writeSpatialCanvas(standalone, {
        nodes: [{ id: 'n1', type: 'text', x: 1, y: 2, width: 80, height: 40, text: 'carry me' }],
        edges: [],
      })

      const doc = workspace()
      adoptWorkspaceDocument(
        doc,
        { path: 'design', documentId: ID_A, kind: 'spatial', name: 'Design' },
        standalone,
      )

      const projected = projectWorkspaceDocument(doc, ID_A)
      expect(projected).not.toBeNull()
      if (projected === null) return
      expect(readSpatialCanvas(projected).nodes).toEqual([
        { id: 'n1', type: 'text', x: 1, y: 2, width: 80, height: 40, text: 'carry me' },
      ])
      // Node meta (segment, kind, name, documentId) is tree bookkeeping, not
      // document content — a projection carrying it would invent root
      // containers no standalone document ever had.
      const roots = projected.toJSON() as Record<string, unknown>
      expect(Object.keys(roots)).not.toContain('segment')
      expect(Object.keys(roots)).not.toContain('kind')
      expect(Object.keys(roots)).not.toContain('documentId')
    })

    it('answers null for an id the tree does not hold', () => {
      expect(projectWorkspaceDocument(workspace(), ID_A)).toBeNull()
    })
  })

  describe('adopting a standalone document (the migration step)', () => {
    it('copies the root containers onto the node and keeps the documentId', () => {
      const standalone = new LoroDoc()
      standalone.setPeerId(9n)
      writeSpatialCanvas(standalone, {
        nodes: [{ id: 'n1', type: 'text', x: 5, y: 6, width: 80, height: 40, text: 'moved in' }],
        edges: [],
      })

      const doc = workspace()
      const adopted = adoptWorkspaceDocument(
        doc,
        { path: 'imported/design', documentId: ID_A, kind: 'spatial' },
        standalone,
      )

      expect(adopted?.documentId).toBe(ID_A)
      expect(adopted?.path).toBe('imported/design')
      const read = readSpatialCanvas(documentContainers(doc, ID_A))
      expect(read.nodes).toHaveLength(1)
      expect(read.nodes[0]?.type === 'text' ? read.nodes[0].text : null).toBe('moved in')
    })

    it('answers null without writing when the id is already in the tree', () => {
      const doc = workspace()
      createWorkspaceDocument(doc, { documentId: ID_A, segment: 'design', kind: 'spatial' })
      const before = doc.oplogVersion().encode()

      const again = adoptWorkspaceDocument(
        doc,
        { path: 'design', documentId: ID_A, kind: 'spatial' },
        new LoroDoc(),
      )

      // The re-run safety of the whole fold: a document already carried over
      // is not work, and must not become a second node either.
      expect(again).toBeNull()
      expect(doc.oplogVersion().encode()).toEqual(before)
    })
  })

  describe('what convergence decides, not this code', () => {
    it('lets both siblings survive a concurrent same-segment create', () => {
      const a = workspace()
      createWorkspaceDocument(a, { documentId: ID_A, segment: 'design', kind: 'spatial' })
      const b = LoroDoc.fromSnapshot(a.export({ mode: 'snapshot' }))
      b.setPeerId(2n)

      createWorkspaceDocument(a, { documentId: ID_B, segment: 'notes', kind: 'markdown' })
      createWorkspaceDocument(b, { documentId: ID_C, segment: 'notes', kind: 'markdown' })
      a.import(b.export({ mode: 'update' }))
      b.import(a.export({ mode: 'update' }))

      // Both are there, on both peers, in the same order. Path uniqueness
      // cannot be an invariant in a CRDT, so the honest listing shows the
      // collision rather than hiding half of it.
      const onA = readWorkspaceDocuments(a).filter((entry) => entry.path === 'notes')
      const onB = readWorkspaceDocuments(b).filter((entry) => entry.path === 'notes')
      expect(onA).toHaveLength(2)
      expect(onA.map((entry) => entry.documentId)).toEqual(onB.map((entry) => entry.documentId))
      // Exactly one owns the path, and it is the same one on both peers.
      expect(onA.filter((entry) => !entry.shadowed)).toHaveLength(1)
      expect(resolveWorkspaceDocument(a, 'notes')?.documentId).toBe(
        resolveWorkspaceDocument(b, 'notes')?.documentId,
      )
    })

    it('lets a delete win over a concurrent edit', () => {
      const a = workspace()
      createWorkspaceDocument(a, { documentId: ID_A, segment: 'design', kind: 'spatial' })
      const b = LoroDoc.fromSnapshot(a.export({ mode: 'snapshot' }))
      b.setPeerId(2n)

      deleteWorkspaceDocument(a, { documentId: ID_A })
      writeSpatialCanvas(documentContainers(b, ID_A), {
        nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 80, height: 40, text: 'late' }],
        edges: [],
      })
      a.import(b.export({ mode: 'update' }))
      b.import(a.export({ mode: 'update' }))

      // Gone on both, and the edit does not resurrect it. Restoring is a copy
      // under the same documentId, not an undelete — a deleted tree node
      // cannot be moved back.
      expect(readWorkspaceDocuments(a)).toEqual([])
      expect(readWorkspaceDocuments(b)).toEqual([])
    })
  })
})
