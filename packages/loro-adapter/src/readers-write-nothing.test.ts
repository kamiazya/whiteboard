// A read of a document hosted on a workspace record must not move the record. A
// tree node opens a container by WRITING it, so a reader that asks for one the
// node lacks (an older record, or a note whose content arrived another way)
// adds an op to the shared record the keeper caches: the cache then runs ahead
// of what was stored, and every frontier taken from it names ops nobody saved.
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { readAnnotations, retiredCommentRows } from './annotations.js'
import { readCommentThreads, threadMessageCounts } from './comment-threads.js'
import type { DocumentContainers } from './containers.js'
import * as K from './containers.js'
import { readContentWithTags, readDocumentContent } from './document-content.js'
import {
  readCoreFacets,
  readDocumentKind,
  readFacets,
  readTrustFacets,
} from './document-envelope.js'
import { readCanvasFacets } from './document-envelope-reconcile.js'
import { collectImageRefIds } from './image-refs.js'
import {
  readEdgeLocks,
  readNodeLocks,
  readSpatialCanvas,
  readSpatialCanvasWithSkipped,
} from './loro-bridge.js'
import { readMarkdownBody } from './markdown-body.js'
import { readProposals } from './proposals.js'
import { retiredStoredShapeIn } from './retired-stored-shape.js'
import { countSpatialNodes } from './spatial-node-count.js'
import { readThreadMarks } from './thread-marks.js'
import { createWorkspaceDocumentAtPath, documentContainers } from './workspace-tree.js'

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FB1'
const CONTENT_KEYS = [
  K.NODES_KEY,
  K.EDGES_KEY,
  K.LINES_KEY,
  K.CANVAS_KEY,
  K.FACETS_KEY,
  K.CORE_KEY,
  K.TRUST_KEY,
  K.DOCUMENT_KEY,
  K.THREADS_KEY,
  K.PROPOSALS_KEY,
  K.NODE_LOCKS_KEY,
  K.EDGE_LOCKS_KEY,
  K.MARKDOWN_BODY_KEY,
  K.RETIRED_COMMENTS_KEY,
  K.RETIRED_ELEMENTS_KEY,
]

/** A record whose document's node holds none of the content containers. */
function bare(kind: 'markdown' | 'spatial') {
  const record = new LoroDoc()
  createWorkspaceDocumentAtPath(record, { path: 'doc', documentId: ID, kind })
  const node = record
    .getTree('tree')
    .getNodes()
    .find((n) => n.data.get('documentId') === ID)
  for (const key of CONTENT_KEYS) node?.data.delete(key)
  record.commit()
  return { record, keys: () => [...(node?.data.keys() ?? [])].sort() }
}

const READERS: ReadonlyArray<readonly [string, (doc: DocumentContainers) => unknown]> = [
  ['readSpatialCanvas', readSpatialCanvas],
  ['readSpatialCanvasWithSkipped', readSpatialCanvasWithSkipped],
  ['countSpatialNodes', countSpatialNodes],
  ['readNodeLocks', readNodeLocks],
  ['readEdgeLocks', readEdgeLocks],
  ['readFacets', readFacets],
  ['readCoreFacets', readCoreFacets],
  ['readTrustFacets', readTrustFacets],
  ['readDocumentKind', readDocumentKind],
  ['readCanvasFacets', readCanvasFacets],
  ['readMarkdownBody', readMarkdownBody],
  ['readProposals', readProposals],
  ['readAnnotations', readAnnotations],
  ['readCommentThreads', readCommentThreads],
  ['threadMessageCounts', threadMessageCounts],
  ['readThreadMarks', readThreadMarks],
  ['readDocumentContent', readDocumentContent],
  ['readContentWithTags', readContentWithTags],
  ['collectImageRefIds', collectImageRefIds],
  ['retiredCommentRows', retiredCommentRows],
  ['retiredStoredShapeIn', retiredStoredShapeIn],
]

describe('a reader of a hosted document that lacks its containers', () => {
  for (const kind of ['markdown', 'spatial'] as const) {
    it.each(READERS)(`%s leaves a ${kind} record as it was`, (_name, read) => {
      const { record, keys } = bare(kind)
      const version = JSON.stringify([...record.version().toJSON()])
      const held = keys()
      try {
        read(documentContainers(record, ID))
      } catch {
        // A refusal is a read's own answer; what matters is that it wrote nothing.
      }
      record.commit()
      expect(JSON.stringify([...record.version().toJSON()])).toBe(version)
      expect(keys()).toEqual(held)
    })
  }
})
