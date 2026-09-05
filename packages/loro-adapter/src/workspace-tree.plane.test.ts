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
  readWorkspaceDocumentPlane,
  resolveWorkspaceDocumentById,
} from './workspace-tree.js'

const DOCUMENT_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ'
const PLANE = 'branches'

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
