/**
 * A read never changes the record it reads. Asking a `LoroDoc` for a root
 * container it does not hold registers it, and a snapshot of the record then
 * carries the empty root, so the record's bytes depend on who looked: a
 * keeper's listing of an empty trash must not make the next export differ.
 *
 * Every query the engine answers runs here against a record that lacks the
 * containers that query reads, and the record's state, frontiers and snapshot
 * bytes must be the same afterwards.
 */
import type { documentEngine } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { writeMarkdownBody } from '../markdown-body.js'
import { recordTrashEntry } from '../workspace-trash.js'
import { createWorkspaceDocumentAtPath, documentContainers } from '../workspace-tree.js'
import { READERS, readQuery } from './readers.js'

const NOTE = '01BRWAAAAAAAAAAAAAAAAAAAA0'
const BOARD = '01BRWAAAAAAAAAAAAAAAAAAAA1'

/** A record of two documents and nothing else: no trash, no pins, no comments, no files. */
function bareRecord(): LoroDoc {
  const doc = new LoroDoc()
  doc.setPeerId(2n)
  createWorkspaceDocumentAtPath(doc, { path: 'note', documentId: NOTE, kind: 'markdown' })
  createWorkspaceDocumentAtPath(doc, { path: 'board', documentId: BOARD, kind: 'spatial' })
  writeMarkdownBody(documentContainers(doc, NOTE), '# note')
  doc.commit()
  return doc
}

const document = { documentId: NOTE }
const noArgs = {}

/** The arguments each query is asked with; a query added to the contract is a type error until it is listed. */
const ARGS: Record<documentEngine.QueryName, Record<string, unknown>> = {
  documentKind: document,
  documentContent: { ...document, kind: 'markdown' },
  documentContentWithTags: { ...document, kind: 'markdown' },
  spatialCanvas: { documentId: BOARD },
  nodeLocks: { documentId: BOARD },
  edgeLocks: { documentId: BOARD },
  spatialNodeCount: { documentId: BOARD },
  markdownBody: document,
  bodyDelta: document,
  coreFacets: document,
  trustFacets: document,
  facets: document,
  annotations: document,
  commentThreads: document,
  threadMessageCounts: document,
  threadMarks: document,
  proposals: document,
  imageRefIds: document,
  retiredStoredShape: document,
  retiredCommentRows: document,
  stateSize: document,
  contentDigest: document,
  textLimitBreach: document,
  documents: noArgs,
  nodes: noArgs,
  meta: noArgs,
  pinned: noArgs,
  trash: noArgs,
  folderNames: noArgs,
  unreadableNodes: noArgs,
  removedSince: { since: [] },
  touchedSince: { since: [] },
  organisationChangedSince: { since: [] },
  fileReferences: noArgs,
  containerPlace: { container: 'cid:root-absent:Map' },
  workspaceDocumentEntry: document,
  workspaceDocumentProjection: document,
}

function seen(doc: LoroDoc) {
  return {
    shallow: JSON.stringify(doc.getShallowValue()),
    frontiers: JSON.stringify(doc.frontiers()),
    snapshot: Buffer.from(doc.export({ mode: 'snapshot' })).toString('base64'),
  }
}

async function movedBy(query: documentEngine.QueryName, record: LoroDoc): Promise<boolean> {
  const doc = LoroDoc.fromSnapshot(record.export({ mode: 'snapshot' }))
  const before = seen(doc)
  await readQuery(doc, { query, args: ARGS[query] })
  const after = seen(doc)
  return (
    before.shallow !== after.shallow ||
    before.frontiers !== after.frontiers ||
    before.snapshot !== after.snapshot
  )
}

describe('a read leaves the record it reads as it was', () => {
  it('lists every query the engine answers, so one added later is judged too', () => {
    expect(Object.keys(ARGS).sort()).toEqual(Object.keys(READERS).sort())
    expect(Object.keys(READERS).length).toBeGreaterThan(30)
  })

  it.each(
    Object.keys(READERS) as documentEngine.QueryName[],
  )('does not register a container for %s on a record without trash, pins or comments', async (query) => {
    expect(await movedBy(query, bareRecord())).toBe(false)
  })

  it('does not move a record that holds trash either', async () => {
    const record = bareRecord()
    recordTrashEntry(record, {
      documentId: '01BRWAAAAAAAAAAAAAAAAAAAA2',
      path: 'gone',
      deletedAt: 1,
      blob: { algorithm: 'sha-256', digestHex: 'a'.repeat(64) },
    })
    for (const query of Object.keys(READERS) as documentEngine.QueryName[]) {
      expect(await movedBy(query, record), query).toBe(false)
    }
  })
})
