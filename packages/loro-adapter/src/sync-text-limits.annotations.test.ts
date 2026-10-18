import {
  type CommentThread,
  DOCUMENT_MAX_OPEN_CHANGES,
  DOCUMENT_MAX_OPEN_THREADS,
  type Proposal,
  type ProposedChange,
} from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { setCommentThreadStatus, writeThreadInto, writeThreadMessage } from './comment-threads.js'
import { COMMENTS_KEY, type DocumentContainers } from './containers.js'
import { setProposedChangeStatusInto, writeProposal } from './proposals.js'
import {
  importWithinTextLimits,
  SYNC_TEXT_BREACH_CODES,
  syncTextLimitJudge,
} from './sync-text-limits.js'
import { createWorkspaceDocumentAtPath, documentContainers } from './workspace-tree.js'

const DOC_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'

const thread = (i: number | string, status: CommentThread['status'] = 'open'): CommentThread => ({
  id: `t${i}`,
  anchor: { kind: 'spatial', x: 0, y: 0 },
  status,
  messages: [{ id: `t${i}-m1`, body: 'is this right?' }],
})

const change = (i: number | string, status: ProposedChange['status'] = 'open'): ProposedChange => ({
  id: `ch${i}`,
  status,
  op: 'node.add',
  node: textNode({ id: `n${i}`, x: 0, y: 0, width: 100, height: 40, text: 'x' }),
})

const proposal = (id: string, changes: ProposedChange[]): Proposal => ({ id, changes })

/** Where the document lives: inside a workspace record, or at its own root. */
const PLACEMENTS = {
  'a workspace record': (doc: LoroDoc): DocumentContainers => {
    createWorkspaceDocumentAtPath(doc, { path: 'board', documentId: DOC_ID, kind: 'spatial' })
    return documentContainers(doc, DOC_ID)
  },
  "a document's own root": (doc: LoroDoc): DocumentContainers => doc,
} as const

type Placement = keyof typeof PLACEMENTS
const reopen = (placement: Placement, doc: LoroDoc): DocumentContainers =>
  placement === 'a workspace record' ? documentContainers(doc, DOC_ID) : doc

function stored(placement: Placement, seed: (doc: DocumentContainers) => void): LoroDoc {
  const doc = new LoroDoc()
  seed(PLACEMENTS[placement](doc))
  doc.commit()
  return doc
}

function threads(open: number, resolved = 0) {
  return (doc: DocumentContainers) => {
    for (let i = 0; i < open; i += 1) writeThreadInto(doc, thread(i))
    for (let i = 0; i < resolved; i += 1) writeThreadInto(doc, thread(`r${i}`, 'resolved'))
  }
}

function updateFrom(
  placement: Placement,
  base: LoroDoc,
  edit: (doc: DocumentContainers) => void,
): Uint8Array {
  const client = base.fork()
  const from = client.oplogVersion()
  edit(reopen(placement, client))
  client.commit()
  return client.export({ mode: 'update', from })
}

/** Both keepers' verdicts, which must agree. */
function judged(base: LoroDoc, update: Uint8Array) {
  const imported = importWithinTextLimits(base.fork(), update).breach
  expect(syncTextLimitJudge(base)(update)).toEqual(imported)
  return imported
}

describe.each(Object.keys(PLACEMENTS) as Placement[])('a document in %s', (placement) => {
  describe('open comment threads', () => {
    it('refuses a thread opened past the per-document ceiling', () => {
      const base = stored(placement, threads(DOCUMENT_MAX_OPEN_THREADS))
      const update = updateFrom(placement, base, (doc) => writeThreadInto(doc, thread('extra')))
      expect(judged(base, update)).toEqual({
        shape: 'open-threads',
        count: DOCUMENT_MAX_OPEN_THREADS + 1,
        container: expect.any(String),
      })
    })

    it('refuses reopening a resolved thread past the ceiling', () => {
      const base = stored(placement, threads(DOCUMENT_MAX_OPEN_THREADS, 1))
      const update = updateFrom(placement, base, (doc) =>
        setCommentThreadStatus(doc, 'tr0', 'open'),
      )
      expect(judged(base, update)).toMatchObject({
        shape: 'open-threads',
        count: DOCUMENT_MAX_OPEN_THREADS + 1,
      })
    })

    it('counts only open threads, so resolving one makes room for another', () => {
      const base = stored(placement, threads(DOCUMENT_MAX_OPEN_THREADS, 3))
      const update = updateFrom(placement, base, (doc) => {
        setCommentThreadStatus(doc, 't0', 'resolved')
        writeThreadInto(doc, thread('extra'))
      })
      expect(judged(base, update)).toBeNull()
    })

    it('counts a legacy comment row as the thread every reader lifts it into', () => {
      const base = stored(placement, threads(DOCUMENT_MAX_OPEN_THREADS))
      const legacy = { id: 'c1', x: 0, y: 0, text: 'from an old peer' }
      const update = updateFrom(placement, base, (doc) =>
        doc.getMap(COMMENTS_KEY).set('c1', legacy),
      )
      expect(judged(base, update)).toMatchObject({
        shape: 'open-threads',
        count: DOCUMENT_MAX_OPEN_THREADS + 1,
      })
    })

    it('does not count a resolved legacy comment row', () => {
      const base = stored(placement, threads(DOCUMENT_MAX_OPEN_THREADS))
      const legacy = { id: 'c1', x: 0, y: 0, text: 'from an old peer', resolved: true }
      const update = updateFrom(placement, base, (doc) =>
        doc.getMap(COMMENTS_KEY).set('c1', legacy),
      )
      expect(judged(base, update)).toBeNull()
    })

    it('takes a reply on a document at the ceiling', () => {
      const base = stored(placement, threads(DOCUMENT_MAX_OPEN_THREADS))
      const update = updateFrom(placement, base, (doc) =>
        writeThreadMessage(doc, 't3', { id: 't3-m2', body: 'yes' }),
      )
      expect(judged(base, update)).toBeNull()
    })

    it('still takes an edit that opens nothing on a document already past the ceiling', () => {
      const base = stored(placement, threads(DOCUMENT_MAX_OPEN_THREADS + 2))
      const update = updateFrom(placement, base, (doc) => {
        setCommentThreadStatus(doc, 't0', 'resolved')
        writeThreadInto(doc, thread('extra'))
      })
      expect(judged(base, update)).toBeNull()
    })
  })

  describe('open proposed changes', () => {
    const openChanges =
      (count: number, decided = 0) =>
      (doc: DocumentContainers) => {
        const changes = Array.from({ length: count }, (_, i) => change(i))
        for (let i = 0; i < decided; i += 1) changes.push(change(`d${i}`, 'dismissed'))
        writeProposal(doc, proposal('p1', changes))
      }

    it('refuses a new proposal whose change takes the document past the ceiling', () => {
      const base = stored(placement, openChanges(DOCUMENT_MAX_OPEN_CHANGES))
      const update = updateFrom(placement, base, (doc) =>
        writeProposal(doc, proposal('p2', [change('extra')])),
      )
      expect(judged(base, update)).toEqual({
        shape: 'open-changes',
        count: DOCUMENT_MAX_OPEN_CHANGES + 1,
        container: expect.any(String),
      })
    })

    it('counts only open changes, so deciding one makes room for another', () => {
      const base = stored(placement, openChanges(DOCUMENT_MAX_OPEN_CHANGES, 2))
      const update = updateFrom(placement, base, (doc) => {
        setProposedChangeStatusInto(doc, 'p1', 'ch0', 'adopted')
        writeProposal(doc, proposal('p2', [change('extra')]))
      })
      expect(judged(base, update)).toBeNull()
    })

    it('refuses reopening a decided change past the ceiling', () => {
      const base = stored(placement, openChanges(DOCUMENT_MAX_OPEN_CHANGES, 1))
      const update = updateFrom(placement, base, (doc) =>
        setProposedChangeStatusInto(doc, 'p1', 'chd0', 'open'),
      )
      expect(judged(base, update)).toMatchObject({
        shape: 'open-changes',
        count: DOCUMENT_MAX_OPEN_CHANGES + 1,
      })
    })
  })
})

it('answers each annotation ceiling with its own refusal code', () => {
  expect(SYNC_TEXT_BREACH_CODES['open-threads']).toBe('too_many_open_threads')
  expect(SYNC_TEXT_BREACH_CODES['open-changes']).toBe('too_many_open_changes')
})
