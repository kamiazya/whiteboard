/**
 * A document's PLANE: a child map on its tree node, for state that belongs
 * to the document without being one of `workspaceNodeMetaSchema`'s scalars.
 *
 * Two properties carry it, and each is a defect that would otherwise be
 * silent. The plane is mergeable, so two replicas opening it independently —
 * the ordinary case, since nothing pre-attaches one — hold each other's
 * entries instead of agreeing on a survivor. And reading one never opens it,
 * because opening writes an activation marker: a read that created the plane
 * would grow the record of every document anybody merely looked at, in a
 * package whose delta log the compaction subsystem pays for forever.
 */
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import {
  createWorkspaceDocument,
  openWorkspaceDocumentPlane,
  projectWorkspaceDocument,
  readWorkspaceDocumentPlane,
  resolveWorkspaceDocumentById,
  writeWorkspaceDocumentContent,
} from './workspace-tree.js'

const DOCUMENT_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ'
const PLANE = 'branches'

/** A standalone document holding one content map — what a projection looks like. */
function makeContent(nodes: Record<string, unknown>): LoroDoc {
  const source = new LoroDoc()
  const map = source.getMap('nodes')
  for (const [key, value] of Object.entries(nodes)) map.set(key, value)
  source.commit()
  return source
}

function recordWithDocument(): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocument(doc, { documentId: DOCUMENT_ID, segment: 'untitled', kind: 'spatial' })
  return doc
}

describe('workspace document planes', () => {
  it('reads back what was written into one', () => {
    const doc = recordWithDocument()
    openWorkspaceDocumentPlane(doc, DOCUMENT_ID, PLANE)?.set('draft', { tip: 'AQID' })
    doc.commit()

    expect(readWorkspaceDocumentPlane(doc, DOCUMENT_ID, PLANE)?.toJSON()).toEqual({
      draft: { tip: 'AQID' },
    })
  })

  it('answers null for a plane nobody has opened, without opening it', () => {
    const doc = recordWithDocument()
    const before = doc.export({ mode: 'snapshot' }).byteLength

    expect(readWorkspaceDocumentPlane(doc, DOCUMENT_ID, PLANE)).toBeNull()

    // The record is byte-identical: a read that opened the plane would have
    // appended its activation op, and the null above would still look right.
    expect(doc.export({ mode: 'snapshot' }).byteLength).toBe(before)
  })

  it('answers null for a document the record does not hold', () => {
    const doc = recordWithDocument()
    const absent = '01JAAAAAAAAAAAAAAAAAAAAAAA'

    expect(openWorkspaceDocumentPlane(doc, absent, PLANE)).toBeNull()
    expect(readWorkspaceDocumentPlane(doc, absent, PLANE)).toBeNull()
  })

  it('keeps both entries when two replicas open the plane having never seen the other', () => {
    const seed = recordWithDocument()
    const a = new LoroDoc()
    a.import(seed.export({ mode: 'snapshot' }))
    const b = new LoroDoc()
    b.import(seed.export({ mode: 'snapshot' }))

    openWorkspaceDocumentPlane(a, DOCUMENT_ID, PLANE)?.set('from-a', 1)
    a.commit()
    openWorkspaceDocumentPlane(b, DOCUMENT_ID, PLANE)?.set('from-b', 2)
    b.commit()
    a.import(b.export({ mode: 'snapshot' }))
    b.import(a.export({ mode: 'snapshot' }))

    for (const replica of [a, b]) {
      expect(readWorkspaceDocumentPlane(replica, DOCUMENT_ID, PLANE)?.toJSON()).toEqual({
        'from-a': 1,
        'from-b': 2,
      })
    }
  })

  it('survives a content save made from a projection taken before it', () => {
    // The production sequence, and the one that makes a plane worth having
    // rather than a trap: a page holds a PROJECTION of the document, then
    // something records a branch tip on the plane, then the page saves its
    // content. If the projection carried the plane, that save writes the
    // plane back as it stood before the tip — reverting it with no error,
    // no conflict, and a green suite.
    //
    // Measured before the fix, through the daemon's merge: a tip set to
    // `AcbqreGZ2OWvNjQ=` read back as `""` after the reconcile's save.
    const doc = recordWithDocument()
    writeWorkspaceDocumentContent(doc, DOCUMENT_ID, makeContent({ a: 1 }))
    // The plane already holds something when the projection is taken — the
    // state production is always in, since a document acquires a plane the
    // first time anything writes one and the projection is taken later.
    openWorkspaceDocumentPlane(doc, DOCUMENT_ID, PLANE)?.set('draft', { tip: '' })
    doc.commit()
    const stale = projectWorkspaceDocument(doc, DOCUMENT_ID)
    if (stale === null) throw new Error('no projection')

    openWorkspaceDocumentPlane(doc, DOCUMENT_ID, PLANE)?.set('draft', { tip: 'AQID' })
    doc.commit()
    writeWorkspaceDocumentContent(doc, DOCUMENT_ID, stale)

    expect(readWorkspaceDocumentPlane(doc, DOCUMENT_ID, PLANE)?.toJSON()).toEqual({
      draft: { tip: 'AQID' },
    })
  })

  it('stays out of a document’s projection, because a plane is not content', () => {
    const doc = recordWithDocument()
    openWorkspaceDocumentPlane(doc, DOCUMENT_ID, PLANE)?.set('draft', { tip: 'AQID' })
    doc.commit()

    const projected = projectWorkspaceDocument(doc, DOCUMENT_ID)

    // Whatever a document exports, imports, renders or digests, it is this
    // projection — so a plane appearing here would leak into all of them.
    expect(Object.keys(projected?.toJSON() ?? {})).not.toContain(PLANE)
  })

  it('leaves the document reading as itself, and a meta field unreadable as a plane', () => {
    const doc = recordWithDocument()
    const before = resolveWorkspaceDocumentById(doc, DOCUMENT_ID)

    openWorkspaceDocumentPlane(doc, DOCUMENT_ID, PLANE)?.set('draft', { tip: '' })
    doc.commit()

    // The entry is unchanged INCLUDING its `contentDigest`, which is the
    // property that matters: the digest keys every cached picture of this
    // document, so a plane write that moved it would invalidate every
    // rendered thumbnail each time somebody recorded a branch tip. It is
    // computed over CONTENT_CONTAINER_KEYS and a plane is not one of them.
    // `segment`, a scalar, is likewise not readable as a plane.
    expect(resolveWorkspaceDocumentById(doc, DOCUMENT_ID)).toEqual(before)
    expect(readWorkspaceDocumentPlane(doc, DOCUMENT_ID, 'segment')).toBeNull()
  })
})
