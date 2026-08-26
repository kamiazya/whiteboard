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
import { LoroDoc, UndoManager } from 'loro-crdt'
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
  readPinnedDocumentIds,
  readWorkspaceDocuments,
  readWorkspaceMeta,
  reconcileDocContent,
  resolveWorkspaceDocument,
  resolveWorkspaceDocumentById,
  setWorkspaceDocumentName,
  setWorkspaceLastCompactedAt,
  setWorkspacePinned,
  updateWorkspaceDocumentMeta,
  writeWorkspaceDocumentContent,
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
    it('a READ between undo and redo does not clear the redo stack', () => {
      // On a tree node, attaching a container is an op. Before containers
      // were pre-attached at creation, undoing a node-create detached the
      // `nodes` map, the next READ re-attached it via getOrCreateContainer —
      // a local op — and that op cleared the redo stack: create → undo →
      // read → redo left the document empty. This is the page's exact flow
      // (undo publishes a canvas read before redo can be clicked).
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

  describe('writing standalone content onto an existing node', () => {
    it('an unchanged document produces NO new ops, and a one-node change touches only that entry', async () => {
      // The daemon write-through calls this on every save; a wholesale
      // rewrite would append a full-document delta per keystroke burst and
      // grow the workspace log with copies of unchanged state.
      const standalone = new LoroDoc()
      standalone.setPeerId(9n)
      writeSpatialCanvas(standalone, {
        nodes: [
          { id: 'n-a', type: 'text', x: 0, y: 0, width: 80, height: 40, text: 'aa' },
          { id: 'n-b', type: 'text', x: 100, y: 0, width: 80, height: 40, text: 'bb' },
        ],
        edges: [],
      })
      const doc = workspace()
      adoptWorkspaceDocument(doc, { path: 'design', documentId: ID_A, kind: 'spatial' }, standalone)

      // Same content again: nothing may change.
      const before = doc.oplogVersion()
      writeWorkspaceDocumentContent(doc, ID_A, standalone)
      expect(doc.oplogVersion().compare(before)).toBe(0)

      // One node moves: the OTHER node's entry must not be rewritten — a
      // peer edit to it merged over this update has to survive.
      const moved = new LoroDoc()
      moved.setPeerId(9n)
      writeSpatialCanvas(moved, {
        nodes: [
          { id: 'n-a', type: 'text', x: 5, y: 5, width: 80, height: 40, text: 'aa' },
          { id: 'n-b', type: 'text', x: 100, y: 0, width: 80, height: 40, text: 'bb' },
        ],
        edges: [],
      })
      const peer = new LoroDoc()
      peer.import(doc.export({ mode: 'snapshot' }))
      const from = doc.version()
      writeWorkspaceDocumentContent(doc, ID_A, moved)
      writeSpatialCanvas(documentContainers(peer, ID_A), {
        nodes: [
          { id: 'n-a', type: 'text', x: 0, y: 0, width: 80, height: 40, text: 'aa' },
          { id: 'n-b', type: 'text', x: 100, y: 0, width: 80, height: 40, text: 'peer-renamed' },
        ],
        edges: [],
      })
      peer.import(doc.export({ mode: 'update', from }))
      const mergedRead = readSpatialCanvas(documentContainers(peer, ID_A))
      expect(mergedRead.nodes.find((n) => n.id === 'n-a')).toMatchObject({ x: 5, y: 5 })
      expect(mergedRead.nodes.find((n) => n.id === 'n-b')).toMatchObject({
        text: 'peer-renamed',
      })
    })

    it('an entry removed from the source is deleted from the node', () => {
      const standalone = new LoroDoc()
      writeSpatialCanvas(standalone, {
        nodes: [
          { id: 'n-a', type: 'text', x: 0, y: 0, width: 80, height: 40, text: 'aa' },
          { id: 'n-b', type: 'text', x: 100, y: 0, width: 80, height: 40, text: 'bb' },
        ],
        edges: [],
      })
      const doc = workspace()
      adoptWorkspaceDocument(doc, { path: 'design', documentId: ID_A, kind: 'spatial' }, standalone)

      const shrunk = new LoroDoc()
      writeSpatialCanvas(shrunk, {
        nodes: [{ id: 'n-a', type: 'text', x: 0, y: 0, width: 80, height: 40, text: 'aa' }],
        edges: [],
      })
      writeWorkspaceDocumentContent(doc, ID_A, shrunk)
      expect(readSpatialCanvas(documentContainers(doc, ID_A)).nodes.map((n) => n.id)).toEqual([
        'n-a',
      ])
    })

    it('a legacy movable-list container (`elements`) survives write and projection as a value copy', () => {
      // Old clients still push `elements` MovableList docs through the
      // daemon's update route. The tree cannot silently drop a container
      // kind it does not favour — that turns a rename into content loss.
      const standalone = new LoroDoc()
      const list = standalone.getMovableList('elements')
      list.push({ id: 'old-element' })
      standalone.commit()

      const doc = workspace()
      adoptWorkspaceDocument(doc, { path: 'legacy', documentId: ID_A, kind: 'spatial' }, standalone)

      const projected = projectWorkspaceDocument(doc, ID_A)
      expect(projected).not.toBeNull()
      if (projected === null) return
      expect(projected.getMovableList('elements').toJSON()).toEqual([{ id: 'old-element' }])

      // And the diff write keeps it in step.
      const changed = new LoroDoc()
      const changedList = changed.getMovableList('elements')
      changedList.push({ id: 'old-element' })
      changedList.push({ id: 'second' })
      changed.commit()
      writeWorkspaceDocumentContent(doc, ID_A, changed)
      const reprojected = projectWorkspaceDocument(doc, ID_A)
      expect(reprojected?.getMovableList('elements').toJSON()).toEqual([
        { id: 'old-element' },
        { id: 'second' },
      ])
    })

    it('a text container is replaced only when its content differs', () => {
      const standalone = new LoroDoc()
      standalone.getText('body').insert(0, '# hello')
      standalone.commit()
      const doc = workspace()
      adoptWorkspaceDocument(doc, { path: 'notes', documentId: ID_A, kind: 'markdown' }, standalone)

      const before = doc.oplogVersion()
      writeWorkspaceDocumentContent(doc, ID_A, standalone)
      expect(doc.oplogVersion().compare(before)).toBe(0)

      const changed = new LoroDoc()
      changed.getText('body').insert(0, '# hello, changed')
      changed.commit()
      writeWorkspaceDocumentContent(doc, ID_A, changed)
      expect(documentContainers(doc, ID_A).getText('body').toString()).toBe('# hello, changed')
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

describe('projection at a checkout', () => {
  it('projects the PAST state out of a detached workspace clone', () => {
    const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    const ws = new LoroDoc()
    createWorkspaceDocumentAtPath(ws, { path: 'design', documentId: ID, kind: 'spatial' })
    writeSpatialCanvas(documentContainers(ws, ID), {
      nodes: [{ id: 'n-a', type: 'text', x: 0, y: 0, width: 80, height: 40, text: 'v1' }],
      edges: [],
    })
    const pastFrontiers = ws.frontiers()
    writeSpatialCanvas(documentContainers(ws, ID), {
      nodes: [
        { id: 'n-a', type: 'text', x: 0, y: 0, width: 80, height: 40, text: 'v2' },
        { id: 'n-b', type: 'text', x: 100, y: 0, width: 80, height: 40, text: 'later' },
      ],
      edges: [],
    })

    const clone = LoroDoc.fromSnapshot(ws.export({ mode: 'snapshot' }))
    clone.checkout(pastFrontiers)
    const past = projectWorkspaceDocument(clone, ID)
    expect(past).not.toBeNull()
    if (past === null) return
    const nodes = readSpatialCanvas(past).nodes
    expect(nodes.map((n) => n.id)).toEqual(['n-a'])
    expect(nodes[0]?.type === 'text' ? nodes[0].text : null).toBe('v1')
  })
})

describe('reconcileDocContent (restore = a new edit equal to the past)', () => {
  it('makes the target equal the past: later additions tombstone, changed fields revert', () => {
    const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    void ID
    const live = new LoroDoc()
    writeSpatialCanvas(live, {
      nodes: [
        { id: 'n-a', type: 'text', x: 9, y: 9, width: 80, height: 40, text: 'edited' },
        { id: 'n-b', type: 'text', x: 100, y: 0, width: 80, height: 40, text: 'later' },
      ],
      edges: [],
    })
    const past = new LoroDoc()
    writeSpatialCanvas(past, {
      nodes: [{ id: 'n-a', type: 'text', x: 0, y: 0, width: 80, height: 40, text: 'v1' }],
      edges: [],
    })

    reconcileDocContent(live, past)
    const nodes = readSpatialCanvas(live).nodes
    expect(nodes.map((n) => n.id)).toEqual(['n-a'])
    expect(nodes[0]).toMatchObject({ x: 0, y: 0, text: 'v1' })
  })

  it('an equal past commits no ops, and a movable-list root reconciles too', () => {
    const live = new LoroDoc()
    const list = live.getMovableList('elements')
    list.push({ id: 'a' })
    list.push({ id: 'b' })
    live.commit()

    const same = LoroDoc.fromSnapshot(live.export({ mode: 'snapshot' }))
    const before = live.oplogVersion()
    reconcileDocContent(live, same)
    expect(live.oplogVersion().compare(before)).toBe(0)

    const past = new LoroDoc()
    past.getMovableList('elements').push({ id: 'a' })
    past.commit()
    reconcileDocContent(live, past)
    expect(live.getMovableList('elements').toJSON()).toEqual([{ id: 'a' }])
  })
})

describe('row-relocated meta (dual-plane collapse S4a)', () => {
  const ULID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
  const ULID_B = '01BX5ZZKBKACTAV9WEVGEMMVRZ'

  it('round-trips currentBranch / createdAt / updatedAt through node meta', () => {
    const doc = new LoroDoc()
    createWorkspaceDocumentAtPath(doc, { path: 'a', documentId: ULID_A, kind: 'spatial' })
    updateWorkspaceDocumentMeta(doc, ULID_A, {
      currentBranch: 'feature',
      createdAt: 111,
      updatedAt: 222,
    })
    doc.commit()

    const entry = resolveWorkspaceDocumentById(doc, ULID_A)
    expect(entry?.currentBranch).toBe('feature')
    expect(entry?.createdAt).toBe(111)
    expect(entry?.updatedAt).toBe(222)
  })

  it('a replica that merges the meta write converges on it', () => {
    const doc = new LoroDoc()
    createWorkspaceDocumentAtPath(doc, { path: 'a', documentId: ULID_A, kind: 'spatial' })
    doc.commit()
    const replica = new LoroDoc()
    replica.import(doc.export({ mode: 'snapshot' }))

    updateWorkspaceDocumentMeta(doc, ULID_A, { updatedAt: 999 })
    doc.commit()
    replica.import(doc.export({ mode: 'update' }))

    expect(resolveWorkspaceDocumentById(replica, ULID_A)?.updatedAt).toBe(999)
  })

  // readMeta tries the document parse first; a folder must keep parsing as a
  // folder even now that document meta carries more optional fields — a
  // misparse here would surface folders as malformed documents.
  it('a folder node still reads as a folder alongside the extended document meta', () => {
    const doc = new LoroDoc()
    createWorkspaceDocumentAtPath(doc, { path: 'dir/leaf', documentId: ULID_A, kind: 'spatial' })
    updateWorkspaceDocumentMeta(doc, ULID_A, { currentBranch: 'main', updatedAt: 1 })
    doc.commit()

    const entries = readWorkspaceDocuments(doc)
    expect(entries.map((e) => e.path)).toEqual(['dir/leaf'])
  })

  it('pinned document ids live in a workspace-level movable list, in order', () => {
    const doc = new LoroDoc()
    createWorkspaceDocumentAtPath(doc, { path: 'a', documentId: ULID_A, kind: 'spatial' })
    createWorkspaceDocumentAtPath(doc, { path: 'b', documentId: ULID_B, kind: 'spatial' })

    expect(readPinnedDocumentIds(doc)).toEqual([])
    setWorkspacePinned(doc, ULID_B, true)
    setWorkspacePinned(doc, ULID_A, true)
    doc.commit()
    expect(readPinnedDocumentIds(doc)).toEqual([ULID_B, ULID_A])

    // Idempotent re-pin keeps position; unpin removes.
    setWorkspacePinned(doc, ULID_B, true)
    expect(readPinnedDocumentIds(doc)).toEqual([ULID_B, ULID_A])
    setWorkspacePinned(doc, ULID_B, false)
    expect(readPinnedDocumentIds(doc)).toEqual([ULID_A])
    // Unpinning an id that is not pinned is a no-op on the list.
    setWorkspacePinned(doc, ULID_B, false)
    expect(readPinnedDocumentIds(doc)).toEqual([ULID_A])
  })

  it('lastCompactedAt is workspace-level meta', () => {
    const doc = new LoroDoc()
    expect(readWorkspaceMeta(doc).lastCompactedAt).toBeUndefined()
    setWorkspaceLastCompactedAt(doc, 12345)
    doc.commit()
    expect(readWorkspaceMeta(doc).lastCompactedAt).toBe(12345)
  })
})
