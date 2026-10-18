// A thread's node-set anchor, judged by the sync judge with the other
// per-value bounds. Every layout looks each id up, resolved threads included,
// and the open-thread ceiling counts open threads only — so without this a
// single resolved thread could carry any number of ids into every render.
import { CANVAS_MAX_NODES, type CommentThread } from '@kamiazya/whiteboard-model'
import { LoroDoc, type LoroMap } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { writeThreadInto } from './comment-threads.js'
import { type DocumentContainers, THREADS_KEY } from './containers.js'
import {
  importWithinTextLimits,
  SYNC_TEXT_BREACH_CODES,
  syncTextLimitJudge,
} from './sync-text-limits.js'
import { createWorkspaceDocumentAtPath, documentContainers } from './workspace-tree.js'

const DOC_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'

const ids = (count: number) => Array.from({ length: count }, (_, i) => `n${i}`)

const setThread = (
  id: string,
  nodeIds: readonly string[],
  status: CommentThread['status'] = 'resolved',
): CommentThread => ({
  id,
  anchor: { kind: 'spatial', nodeIds: [...nodeIds], x: 0, y: 0, width: 10, height: 10 },
  status,
  messages: [{ id: `${id}-m1`, body: 'about these' }],
})

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

function stored(placement: Placement, seed: (doc: DocumentContainers) => void = () => {}) {
  const doc = new LoroDoc()
  seed(PLACEMENTS[placement](doc))
  doc.commit()
  return doc
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

/** Writes `anchor` over thread `id`'s stored one, as a peer skipping the schema would. */
const overwriteAnchor = (doc: DocumentContainers, id: string, anchor: unknown) =>
  (doc.getMap(THREADS_KEY).get(id) as LoroMap).set('anchor', anchor)

describe.each(Object.keys(PLACEMENTS) as Placement[])('a document in %s', (placement) => {
  it('refuses a resolved thread naming more nodes than one canvas may hold', () => {
    const base = stored(placement)
    const update = updateFrom(placement, base, (doc) =>
      writeThreadInto(doc, setThread('t1', ids(CANVAS_MAX_NODES + 1))),
    )
    expect(judged(base, update)).toEqual({
      shape: 'thread-anchor',
      count: CANVAS_MAX_NODES + 1,
      threadId: 't1',
      container: expect.any(String),
    })
  })

  it('takes a thread naming exactly the bound', () => {
    const base = stored(placement)
    const update = updateFrom(placement, base, (doc) =>
      writeThreadInto(doc, setThread('t1', ids(CANVAS_MAX_NODES))),
    )
    expect(judged(base, update)).toBeNull()
  })

  it('refuses growing a held anchor past the bound', () => {
    const base = stored(placement, (doc) => writeThreadInto(doc, setThread('t1', ids(2), 'open')))
    const update = updateFrom(placement, base, (doc) =>
      overwriteAnchor(doc, 't1', setThread('t1', ids(CANVAS_MAX_NODES + 1)).anchor),
    )
    expect(judged(base, update)).toMatchObject({ shape: 'thread-anchor', threadId: 't1' })
  })

  it('still takes an edit that does not grow an anchor stored past the bound', () => {
    const base = stored(placement, (doc) =>
      writeThreadInto(doc, setThread('t1', ids(CANVAS_MAX_NODES + 10))),
    )
    const update = updateFrom(placement, base, (doc) =>
      overwriteAnchor(doc, 't1', setThread('t1', ids(CANVAS_MAX_NODES + 5)).anchor),
    )
    expect(judged(base, update)).toBeNull()
  })

  it('does not read a message body as an anchor', () => {
    // The bound is on the thread's own `anchor` key; a message map one level
    // down holding a long list under another name is not one.
    const base = stored(placement, (doc) => writeThreadInto(doc, setThread('t1', ids(2))))
    const update = updateFrom(placement, base, (doc) =>
      (doc.getMap(THREADS_KEY).get('t1') as LoroMap).set('note', {
        nodeIds: ids(CANVAS_MAX_NODES + 1),
      }),
    )
    expect(judged(base, update)).toBeNull()
  })
})

it('refuses an over-bound anchor that a record holds into an empty document', () => {
  const record = stored("a document's own root", (doc) =>
    writeThreadInto(doc, setThread('t1', ids(CANVAS_MAX_NODES + 1))),
  )
  expect(
    importWithinTextLimits(new LoroDoc(), record.export({ mode: 'snapshot' })).breach,
  ).toMatchObject({ shape: 'thread-anchor', threadId: 't1' })
})

it('takes an update whose bytes are at least as many as the anchor ids it writes', () => {
  // The answer the judge gives a short update without applying it rests on
  // this: an encoding that shared repeated strings would let a long list of
  // one id through.
  const base = stored("a document's own root")
  for (const nodeIds of [Array(5_000).fill(''), Array(5_000).fill('x')]) {
    const update = updateFrom("a document's own root", base, (doc) =>
      writeThreadInto(doc, setThread('t1', nodeIds)),
    )
    expect(update.byteLength).toBeGreaterThanOrEqual(nodeIds.length)
  }
})

it('answers an anchor breach with its own refusal code', () => {
  expect(SYNC_TEXT_BREACH_CODES['thread-anchor']).toBe('comment_anchor_too_large')
})
