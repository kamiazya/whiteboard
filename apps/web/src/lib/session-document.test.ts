/**
 * The editing session's engine document, asked what the Loro path answers for
 * the same bytes, and held to what the session builds on: one splice per
 * window, a commit before an import, announcements in order, and a handle that
 * is given back exactly once.
 */

import {
  contentDigestOfDocument,
  createWorkspaceDocumentAtPath,
  documentContainers,
  readCoreFacets,
  readEdgeLocks,
  readFacets,
  readMarkdownBody,
  readNodeLocks,
  readSpatialCanvas,
  readWorkspaceDocumentName,
  resolveWorkspaceDocumentById,
  setEdgeLock,
  setNodeLock,
  writeCoreFacets,
  writeFacets,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchEngineHandles } from '../test-utils/replica-lease.js'
import { type ChangedBy, SessionDocument } from './session-document.js'

const DOC = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const CANVAS = {
  nodes: [
    textNode({ id: 'n-a', x: 0, y: 0, width: 100, height: 50, text: 'a' }),
    textNode({ id: 'n-b', x: 200, y: 0, width: 100, height: 50, text: 'b' }),
  ],
  edges: [],
}

function record(kind: 'markdown' | 'spatial', fill: (content: LoroDoc) => void): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'notes', documentId: DOC, kind, name: 'Meeting' })
  fill(documentContainers(doc, DOC) as LoroDoc)
  doc.commit()
  return doc
}

function standalone(body: string): LoroDoc {
  const doc = new LoroDoc()
  writeMarkdownBody(doc, body)
  doc.commit()
  return doc
}

function opened(
  doc: LoroDoc,
  contentDocumentId: string | undefined,
  hooks: { updates?: Uint8Array[]; changes?: ChangedBy[] } = {},
) {
  return new SessionDocument({
    bytes: doc.export({ mode: 'snapshot' }),
    contentDocumentId,
    onLocalUpdate: (update) => hooks.updates?.push(update),
    onChanged: (by) => hooks.changes?.push(by),
  })
}

/** What a second replica holds after being given `base` and then every update. */
function replicaOf(base: LoroDoc, updates: readonly Uint8Array[]): LoroDoc {
  const replica = new LoroDoc()
  replica.import(base.export({ mode: 'snapshot' }))
  for (const update of updates) replica.import(update)
  return replica
}

const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a session document reads what the Loro readers read of the same bytes', () => {
  it('answers a hosted markdown document’s body, name, facets and digest', () => {
    const loro = record('markdown', (content) => {
      writeMarkdownBody(content, '# Notes\n\nhello 😀')
      writeCoreFacets(content, { type: 'note', tags: ['x'] })
      writeFacets(content, { 'plugin.example/v1': { a: 1 } })
    })
    const seam = opened(loro, DOC)
    const content = documentContainers(loro, DOC)

    expect(seam.markdownBody()).toBe(readMarkdownBody(content))
    expect(seam.coreFacets()).toEqual(readCoreFacets(content))
    expect(seam.facets()).toEqual(readFacets(content))
    expect(seam.name()).toBe(readWorkspaceDocumentName(loro, DOC))
    expect(seam.hasEntry()).toBe(true)
    expect(seam.listedContentState()).toBe(resolveWorkspaceDocumentById(loro, DOC)?.contentDigest)
    seam.close()
  })

  it('answers a hosted canvas document’s canvas and locks', () => {
    const loro = record('spatial', (content) => {
      writeSpatialCanvas(content, CANVAS)
      setNodeLock(content, 'n-a', true)
      setEdgeLock(content, 'e-1', true)
    })
    const seam = opened(loro, DOC)
    const content = documentContainers(loro, DOC)

    expect(seam.canvas()).toEqual(readSpatialCanvas(content))
    expect(seam.nodeLocks()).toEqual(readNodeLocks(content))
    expect(seam.edgeLocks()).toEqual(readEdgeLocks(content))
    expect(seam.coreFacets()).toBeUndefined()
    seam.close()
  })

  it('answers a document that is its own record, with no entry and no name', () => {
    const loro = standalone('plain')
    const seam = opened(loro, undefined)

    expect(seam.markdownBody()).toBe('plain')
    expect(seam.hasEntry()).toBe(true)
    expect(seam.name()).toBeUndefined()
    expect(seam.listedContentState()).toBe(contentDigestOfDocument(loro))
    expect(seam.recordContentState()).toBe(contentDigestOfDocument(loro))
    seam.close()
  })

  it('finds a hosted document’s node gone from a record that no longer holds it', () => {
    const seam = opened(standalone('x'), DOC)

    expect(seam.hasEntry()).toBe(false)
    expect(seam.name()).toBeUndefined()
    expect(seam.listedContentState()).toBeNull()
    seam.close()
  })

  it('opens update-format bytes as well as a snapshot', () => {
    const loro = standalone('from an update')
    const seam = new SessionDocument({
      bytes: loro.export({ mode: 'update' }),
      contentDocumentId: undefined,
      onLocalUpdate: () => {},
      onChanged: () => {},
    })

    expect(seam.markdownBody()).toBe('from an update')
    seam.close()
  })

  it('names the retired shapes the readers refuse, and nothing in a readable record', () => {
    const clean = opened(
      record('spatial', (c) => writeSpatialCanvas(c, CANVAS)),
      DOC,
    )
    expect([clean.holdsRetiredCommentPlane(), clean.holdsRetiredStoredShape()]).toEqual([
      false,
      false,
    ])
    clean.close()

    const plane = new LoroDoc()
    writeSpatialCanvas(plane, CANVAS)
    plane.getMap('comments').set('c1', { id: 'c1', x: 0, y: 0, text: 'before threads' })
    plane.commit()
    const withPlane = opened(plane, undefined)
    expect(withPlane.holdsRetiredCommentPlane()).toBe(true)
    withPlane.close()

    const shape = new LoroDoc()
    writeSpatialCanvas(shape, CANVAS)
    shape
      .getMap('nodes')
      .set('old', { id: 'old', type: 'text', text: 'hi', x: 0, y: 0, width: 1, height: 1 })
    shape.commit()
    const withShape = opened(shape, undefined)
    expect(withShape.holdsRetiredStoredShape()).toBe(true)
    withShape.close()
  })
})

describe('the body a session document hands the editor', () => {
  it('shows keystrokes at once and commits the window as one update a replica reads back', () => {
    const base = record('markdown', (c) => writeMarkdownBody(c, 'hello'))
    const updates: Uint8Array[] = []
    const seam = opened(base, DOC, { updates })

    seam.body.insert(5, ' world')
    seam.body.insert(0, '>')
    seam.body.delete(1, 2)

    expect(seam.markdownBody()).toBe('>llo world')
    expect(updates).toHaveLength(0)

    seam.commitBody()

    expect(updates).toHaveLength(1)
    const replica = replicaOf(base, updates)
    expect(readMarkdownBody(documentContainers(replica, DOC))).toBe('>llo world')
    seam.close()
  })

  it('counts positions in UTF-16 units, as the editor does', () => {
    const base = record('markdown', (c) => writeMarkdownBody(c, 'a😀b'))
    const updates: Uint8Array[] = []
    const seam = opened(base, DOC, { updates })

    seam.body.delete(1, 2)
    seam.body.insert(1, '😀😀')
    seam.commitBody()

    expect(seam.markdownBody()).toBe('a😀😀b')
    expect(readMarkdownBody(documentContainers(replicaOf(base, updates), DOC))).toBe('a😀😀b')
    seam.close()
  })

  it('sends nothing when no keystroke is queued', () => {
    const updates: Uint8Array[] = []
    const seam = opened(standalone('x'), undefined, { updates })

    seam.commitBody()

    expect(updates).toHaveLength(0)
    seam.close()
  })

  it('tells a subscriber, after the commit, that the body may have changed', async () => {
    const seam = opened(standalone('x'), undefined)
    const listener = vi.fn()
    seam.body.subscribe(listener)

    seam.body.insert(1, 'y')
    seam.commitBody()
    expect(listener).not.toHaveBeenCalled()
    await settle()

    expect(listener).toHaveBeenCalledTimes(1)
    seam.close()
  })
})

describe('a peer’s bytes imported into a session document', () => {
  function peerInsert(base: LoroDoc, at: number, text: string): Uint8Array {
    const peer = replicaOf(base, [])
    peer.getText('body').insert(at, text)
    peer.commit()
    return peer.export({ mode: 'update' })
  }

  it('commits the queued keystrokes first, as one update that holds only them', () => {
    const base = standalone('hello')
    const updates: Uint8Array[] = []
    const changes: ChangedBy[] = []
    const seam = opened(base, undefined, { updates, changes })

    seam.body.insert(5, ' there')
    seam.importBytes(peerInsert(base, 0, '>'))

    expect(updates).toHaveLength(1)
    expect(replicaOf(base, updates).getText('body').toString()).toBe('hello there')
    expect(seam.markdownBody()).toBe('>hello there')
    expect(changes).toEqual(['local', 'import'])
    seam.close()
  })

  it('announces nothing for bytes the document already holds', () => {
    const base = standalone('hello')
    const changes: ChangedBy[] = []
    const seam = opened(base, undefined, { changes })
    const update = peerInsert(base, 0, '>')

    seam.importBytes(update)
    changes.length = 0
    seam.importBytes(update)

    expect(changes).toEqual([])
    seam.close()
  })

  it('tells the record’s followers once the import has landed', () => {
    const base = standalone('hello')
    const seam = opened(base, undefined)
    const followed = vi.fn()
    seam.subscribeImports(followed)

    seam.importBytes(peerInsert(base, 0, '>'))

    expect(followed).toHaveBeenCalledTimes(1)
    seam.close()
  })
})

describe('writes and history of a session document', () => {
  it('writes a lock as one update a replica reads back, and announces it once', async () => {
    const base = record('spatial', (c) => writeSpatialCanvas(c, CANVAS))
    const updates: Uint8Array[] = []
    const changes: ChangedBy[] = []
    const seam = opened(base, DOC, { updates, changes })

    seam.setNodeLock('n-a', true)
    await settle()

    expect(seam.nodeLocks()).toEqual(new Set(['n-a']))
    expect(updates).toHaveLength(1)
    expect(readNodeLocks(documentContainers(replicaOf(base, updates), DOC))).toEqual(
      new Set(['n-a']),
    )
    expect(changes).toEqual(['local'])
    seam.close()
  })

  it('takes back and replays the last committed step', () => {
    const base = standalone('hello')
    const seam = opened(base, undefined)
    expect([seam.canUndo(), seam.canRedo()]).toEqual([false, false])

    seam.body.insert(5, '!')
    seam.commitBody()
    expect([seam.canUndo(), seam.canRedo()]).toEqual([true, false])

    seam.undo()
    expect(seam.markdownBody()).toBe('hello')
    expect([seam.canUndo(), seam.canRedo()]).toEqual([false, true])

    seam.redo()
    expect(seam.markdownBody()).toBe('hello!')

    seam.clearUndo()
    expect([seam.canUndo(), seam.canRedo()]).toEqual([false, false])
    seam.close()
  })

  it('tells the body’s subscribers of an undo and a redo before the call returns', () => {
    const seam = opened(standalone('hello'), undefined)
    seam.body.insert(5, '!')
    seam.commitBody()
    const listener = vi.fn()
    seam.body.subscribe(listener)

    seam.undo()
    expect(listener).toHaveBeenCalled()
    const afterUndo = listener.mock.calls.length
    seam.redo()
    expect(listener).toHaveBeenCalledTimes(afterUndo + 1)
    seam.close()
  })

  it('commits queued keystrokes as their own step before an undo takes that step back', () => {
    const updates: Uint8Array[] = []
    const seam = opened(standalone('hello'), undefined, { updates })
    seam.body.insert(5, '1')
    seam.commitBody()
    vi.useFakeTimers()
    vi.advanceTimersByTime(1_000)
    seam.body.insert(6, '2')

    seam.undo()
    vi.useRealTimers()

    expect(seam.markdownBody()).toBe('hello1')
    expect(updates).toHaveLength(3)
    seam.close()
  })
})

describe('the handle a session document opens', () => {
  it('is closed exactly once however often the document is closed', async () => {
    const handles = await watchEngineHandles()
    const seam = opened(standalone('x'), undefined)

    seam.close()
    seam.close()

    expect(handles.minted()).toHaveLength(1)
    expect(handles.unaccounted()).toEqual([])
  })

  it('answers a body never read as empty once closed, and takes typing without throwing', () => {
    const seam = opened(standalone('x'), undefined)
    seam.close()

    expect(() => seam.body.insert(0, 'y')).not.toThrow()
    expect(seam.body.toString()).toBe('y')
    expect(seam.markdownBody()).toBe('')
  })

  it('takes no write and announces nothing once closed', async () => {
    const updates: Uint8Array[] = []
    const changes: ChangedBy[] = []
    const seam = opened(standalone('x'), undefined, { updates, changes })
    seam.body.insert(1, 'y')
    seam.commitBody()
    seam.close()
    await settle()

    seam.body.insert(2, 'z')
    seam.commitBody()
    seam.setNodeLock('n', true)
    seam.undo()
    await settle()

    expect(updates).toHaveLength(1)
    expect(changes).toEqual([])
    expect([seam.canUndo(), seam.canRedo()]).toEqual([false, false])
  })
})
