import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { readCommentThreads, threadMessageCounts } from './comment-threads.js'
import { readQueryNow } from './engine/readers.js'
import { createWorkspaceDocumentAtPath, documentContainers } from './workspace-tree.js'

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FB1'

function hosted() {
  const record = new LoroDoc()
  createWorkspaceDocumentAtPath(record, { path: 'note', documentId: ID, kind: 'markdown' })
  // A document stored before threads existed has no container for them.
  record
    .getTree('tree')
    .getNodes()
    .find((candidate) => candidate.data.get('documentId') === ID)
    ?.data.delete('threads')
  record.commit()
  return record
}

/** What a read of a document with no threads must leave alone: the record's history and the node's containers. */
function snapshotOf(record: LoroDoc) {
  const node = record
    .getTree('tree')
    .getNodes()
    .find((candidate) => candidate.data.get('documentId') === ID)
  return {
    version: JSON.stringify([...record.version().toJSON()]),
    frontiers: JSON.stringify(record.oplogFrontiers()),
    keys: [...(node?.data.keys() ?? [])].sort(),
  }
}

describe('reading the threads of a document hosted on a workspace record', () => {
  it.each([
    ['threadMessageCounts', threadMessageCounts, {}],
    ['readCommentThreads', readCommentThreads, []],
  ] as const)('%s answers empty and writes no container', (_name, read, empty) => {
    const record = hosted()
    const before = snapshotOf(record)
    expect(read(documentContainers(record, ID))).toEqual(empty)
    record.commit()
    expect(snapshotOf(record)).toEqual(before)
    expect(before.keys).not.toContain('threads')
  })

  it('the engine queries answer empty and write nothing', () => {
    const record = hosted()
    const before = snapshotOf(record)
    for (const query of ['threadMessageCounts', 'commentThreads', 'annotations'] as const) {
      expect(readQueryNow(record, { query, args: { documentId: ID } })).toMatchObject({
        ok: expect.anything(),
      })
    }
    record.commit()
    expect(snapshotOf(record)).toEqual(before)
  })
})
