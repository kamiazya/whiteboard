// A thread is a nested CONTAINER under `threads` (mergeable, so two peers
// replying at once converge), and the workspace record is what survives a
// restart. The record's fold and projection copy map entries as VALUES, so
// a thread that went through them once came back as a plain object the
// reader skips and the writer trips over — visible only across a restart,
// which no in-process test crosses. These do.
import type { CommentThread } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { readCommentThreads, writeCommentThread, writeThreadMessage } from './comment-threads.js'
import {
  createWorkspaceDocument,
  projectWorkspaceDocument,
  writeWorkspaceDocumentContent,
} from './workspace-tree.js'

const ID = '01HZZZZZZZZZZZZZZZZZZZZZZ1'
const THREAD: CommentThread = {
  id: 't1',
  anchor: { kind: 'spatial', nodeId: 'n1', x: 40, y: 50 },
  status: 'open',
  createdAt: '2026-09-02T00:00:00.000Z',
  messages: [{ id: 'm1', body: 'tighten this', author: 'human:yuki' }],
}

function recordWithDocument(): LoroDoc {
  const record = new LoroDoc()
  record.setPeerId(1n)
  createWorkspaceDocument(record, { documentId: ID, segment: 'board', kind: 'spatial' })
  return record
}

/** What the daemon does between a save and the next read after a restart. */
function reopen(record: LoroDoc): LoroDoc {
  return LoroDoc.fromSnapshot(record.export({ mode: 'snapshot' }))
}

describe('a thread survives the workspace record', () => {
  it('control: a standalone snapshot keeps the thread', () => {
    const doc = new LoroDoc()
    writeCommentThread(doc, THREAD)
    expect(readCommentThreads(reopen(doc))).toEqual([THREAD])
  })

  it('fold into the record, reopen, project: the thread is still a thread', () => {
    const record = recordWithDocument()
    const live = projectWorkspaceDocument(record, ID)
    if (live === null) throw new Error('no projection')
    writeCommentThread(live, THREAD)
    writeWorkspaceDocumentContent(record, ID, live)

    const projected = projectWorkspaceDocument(reopen(record), ID)
    if (projected === null) throw new Error('no projection')
    expect(readCommentThreads(projected)).toEqual([THREAD])
  })

  it('a reply written after the restart lands in the same thread', () => {
    const record = recordWithDocument()
    const live = projectWorkspaceDocument(record, ID)
    if (live === null) throw new Error('no projection')
    writeCommentThread(live, THREAD)
    writeWorkspaceDocumentContent(record, ID, live)

    const projected = projectWorkspaceDocument(reopen(record), ID)
    if (projected === null) throw new Error('no projection')
    writeThreadMessage(projected, THREAD.id, { id: 'm2', body: 'done', author: 'agent:x' })
    expect(readCommentThreads(projected)[0]?.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('a second fold after a reply is a diff, not a rewrite', () => {
    const record = recordWithDocument()
    const live = projectWorkspaceDocument(record, ID)
    if (live === null) throw new Error('no projection')
    writeCommentThread(live, THREAD)
    writeWorkspaceDocumentContent(record, ID, live)
    const frontierAfterFirst = JSON.stringify(record.frontiers())
    // An identical fold commits no ops at all.
    writeWorkspaceDocumentContent(record, ID, live)
    expect(JSON.stringify(record.frontiers())).toBe(frontierAfterFirst)

    writeThreadMessage(live, THREAD.id, { id: 'm2', body: 'done' })
    writeWorkspaceDocumentContent(record, ID, live)
    const projected = projectWorkspaceDocument(reopen(record), ID)
    expect(projected && readCommentThreads(projected)[0]?.messages.map((m) => m.id)).toEqual([
      'm1',
      'm2',
    ])
  })
})
