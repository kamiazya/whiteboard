/**
 * A content copy of a record that already holds a nested container under a
 * key past `CONTAINER_NAME_MAX_CHARS`, stored before the sync judge refused
 * one. A copy rebuilds a nested map, and rebuilt as a mergeable child it would
 * be a root named by that key: past the engine's own bound, the record holding
 * the copy no longer imports, and every document in it goes with it.
 */
import { CONTAINER_NAME_MAX_CHARS, ID_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { readCommentThreads, writeCommentThread } from './comment-threads.js'
import { NODES_KEY, THREADS_KEY } from './containers.js'
import { duplicateWorkspaceDocument } from './workspace-duplicate.js'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  exportWorkspaceSubtree,
  importWorkspaceSubtree,
  projectWorkspaceDocument,
  writeWorkspaceDocumentContent,
} from './workspace-tree.js'

const DOC_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'
const COPY_ID = '01BRWAAAAAAAAAAAAAAAAAAAA1'
const LONG_KEY = 'k'.repeat(70_000)

/** A record holding one board, as a keeper keeps it. */
function record(): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'board', documentId: DOC_ID, kind: 'spatial' })
  doc.commit()
  return doc
}

/** Nests a plain map under `key` in `plane`, the way a write before the judge could. */
function plant(map: LoroMap, key: string): void {
  map.setContainer(key, new LoroMap()).set('a', 1)
}

/** A record holding a nested map under `LONG_KEY` in `plane` of its board. */
function planted(plane: string): LoroDoc {
  const doc = record()
  plant(documentContainers(doc, DOC_ID).getMap(plane), LONG_KEY)
  doc.commit()
  return doc
}

/** The record imports whole once a fresh keeper reads it back. */
function reopened(doc: LoroDoc): LoroDoc {
  const fresh = new LoroDoc()
  fresh.import(doc.export({ mode: 'snapshot' }))
  return fresh
}

/** What the planted entry holds in `documentId`'s `plane`, read through the projection. */
function plantedEntry(doc: LoroDoc, documentId: string, plane: string): unknown {
  return projectWorkspaceDocument(doc, documentId)?.getMap(plane).toJSON()[LONG_KEY]
}

describe.each([NODES_KEY, THREADS_KEY])('a %s entry nested under a key past the bound', (plane) => {
  it('stays openable, and the copy keeps the entry, once the document is duplicated', () => {
    const doc = planted(plane)

    duplicateWorkspaceDocument(doc, {
      sourceDocumentId: DOC_ID,
      documentId: COPY_ID,
      path: 'board-copy',
      name: 'copy',
    })

    const after = reopened(doc)
    expect(plantedEntry(after, COPY_ID, plane)).toEqual({ a: 1 })
    expect(plantedEntry(after, DOC_ID, plane)).toEqual({ a: 1 })
  })

  it('evacuates to trash bytes that restore into a record that still opens', () => {
    const doc = planted(plane)
    const bytes = exportWorkspaceSubtree(doc, 'board')
    if (bytes === null) throw new Error('the board is not in the record')

    // The board was deleted, so the restore lands in a record without it.
    const restored = new LoroDoc()
    importWorkspaceSubtree(restored, bytes)

    expect(plantedEntry(reopened(restored), DOC_ID, plane)).toEqual({ a: 1 })
  })

  it('is written into the record by a tree content write that still opens', () => {
    const doc = record()
    const content = new LoroDoc()
    plant(content.getMap(plane), LONG_KEY)
    content.commit()

    writeWorkspaceDocumentContent(doc, DOC_ID, content)

    expect(plantedEntry(reopened(doc), DOC_ID, plane)).toEqual({ a: 1 })
  })

  it('projects into a document that opens', () => {
    const projected = projectWorkspaceDocument(planted(plane), DOC_ID)
    if (projected === null) throw new Error('the board is not in the record')

    expect(reopened(projected).getMap(plane).toJSON()[LONG_KEY]).toEqual({ a: 1 })
  })
})

describe('a nested entry under a key within the bound', () => {
  it('converges when two keepers each write the same new thread into the record', () => {
    // A thread is mergeable so two keepers that each open it, having never
    // seen the other's, edit one container. The tree write must keep that
    // for every key a writer mints: an id at most `ID_MAX_CHARS` long, far
    // inside `CONTAINER_NAME_MAX_CHARS`.
    expect(ID_MAX_CHARS).toBeLessThan(CONTAINER_NAME_MAX_CHARS / 2)
    const base = record()
    const id = 't'.repeat(ID_MAX_CHARS)
    const keeperWrites = (messageId: string): LoroDoc => {
      const content = new LoroDoc()
      writeCommentThread(content, {
        id,
        anchor: { kind: 'document' },
        status: 'open',
        messages: [{ id: messageId, body: messageId }],
      })
      const keeper = base.fork()
      writeWorkspaceDocumentContent(keeper, DOC_ID, content)
      return keeper
    }
    const a = keeperWrites('from-a')
    const b = keeperWrites('from-b')

    a.import(b.export({ mode: 'update', from: base.oplogVersion() }))

    const [thread] = readCommentThreads(documentContainers(a, DOC_ID))
    expect(thread?.messages.map((message) => message.id).sort()).toEqual(['from-a', 'from-b'])
  })
})
