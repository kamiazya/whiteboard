// A text anchor's quote, judged by the sync judge with the other per-value
// bounds. Every reader of a markdown body re-finds each anchor's passage by
// its quote, so without this a member of a shared workspace could store
// quotes of any length on every thread and every proposed passage.
import {
  type CommentThread,
  type ProposedChange,
  TEXT_ANCHOR_QUOTE_MAX_CHARS,
} from '@kamiazya/whiteboard-model'
import { LoroDoc, type LoroMap } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { writeThreadInto } from './comment-threads.js'
import { type DocumentContainers, PROPOSALS_KEY, THREADS_KEY } from './containers.js'
import { setProposedChangeStatusInto, writeProposal } from './proposals.js'
import {
  importWithinTextLimits,
  SYNC_TEXT_BREACH_CODES,
  syncTextLimitJudge,
} from './sync-text-limits.js'
import { createWorkspaceDocumentAtPath, documentContainers } from './workspace-tree.js'

const DOC_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'

const quoted = (chars: number) => 'q'.repeat(chars)

const textThread = (id: string, chars: number): CommentThread => ({
  id,
  anchor: { kind: 'text', quote: { exact: quoted(chars) }, start: 0, end: chars },
  status: 'open',
  messages: [{ id: `${id}-m1`, body: 'about this' }],
})

const passage = (id: string, chars: number): ProposedChange => ({
  id,
  op: 'body.replace',
  status: 'open',
  anchor: { kind: 'text', quote: { exact: quoted(chars) }, start: 0, end: chars },
  text: 'instead',
  assumed: '',
})

/** Where the document lives: inside a workspace record, or at its own root. */
const PLACEMENTS = {
  'a workspace record': (doc: LoroDoc): DocumentContainers => {
    createWorkspaceDocumentAtPath(doc, { path: 'note', documentId: DOC_ID, kind: 'markdown' })
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

describe.each(Object.keys(PLACEMENTS) as Placement[])('a document in %s', (placement) => {
  it("refuses a thread whose quote is longer than an anchor's may be", () => {
    const base = stored(placement)
    const update = updateFrom(placement, base, (doc) =>
      writeThreadInto(doc, textThread('t1', TEXT_ANCHOR_QUOTE_MAX_CHARS + 1)),
    )
    expect(judged(base, update)).toEqual({
      shape: 'anchor-quote',
      chars: TEXT_ANCHOR_QUOTE_MAX_CHARS + 1,
      elementId: 't1',
      container: expect.any(String),
    })
  })

  it('takes a thread quoting exactly the bound', () => {
    const base = stored(placement)
    const update = updateFrom(placement, base, (doc) =>
      writeThreadInto(doc, textThread('t1', TEXT_ANCHOR_QUOTE_MAX_CHARS)),
    )
    expect(judged(base, update)).toBeNull()
  })

  it("refuses a proposed passage whose quote is longer than an anchor's may be", () => {
    const base = stored(placement)
    const update = updateFrom(placement, base, (doc) =>
      writeProposal(doc, { id: 'p1', changes: [passage('c1', TEXT_ANCHOR_QUOTE_MAX_CHARS + 1)] }),
    )
    expect(judged(base, update)).toEqual({
      shape: 'anchor-quote',
      chars: TEXT_ANCHOR_QUOTE_MAX_CHARS + 1,
      elementId: 'c1',
      container: expect.any(String),
    })
  })

  it('takes a proposed passage quoting exactly the bound', () => {
    const base = stored(placement)
    const update = updateFrom(placement, base, (doc) =>
      writeProposal(doc, { id: 'p1', changes: [passage('c1', TEXT_ANCHOR_QUOTE_MAX_CHARS)] }),
    )
    expect(judged(base, update)).toBeNull()
  })

  it('still takes a verdict on a passage stored past the bound', () => {
    // Adopting or dismissing rewrites the change whole; it does not grow it.
    const base = stored(placement, (doc) =>
      writeProposal(doc, { id: 'p1', changes: [passage('c1', TEXT_ANCHOR_QUOTE_MAX_CHARS + 10)] }),
    )
    const update = updateFrom(placement, base, (doc) =>
      setProposedChangeStatusInto(doc, 'p1', 'c1', 'dismissed'),
    )
    expect(judged(base, update)).toBeNull()
  })

  it('does not read a long value elsewhere in a thread as its anchor', () => {
    const base = stored(placement, (doc) => writeThreadInto(doc, textThread('t1', 4)))
    const update = updateFrom(placement, base, (doc) =>
      (doc.getMap(THREADS_KEY).get('t1') as LoroMap).set('note', {
        quote: { exact: quoted(TEXT_ANCHOR_QUOTE_MAX_CHARS + 1) },
      }),
    )
    expect(judged(base, update)).toBeNull()
  })

  it('does not read the proposals map itself as a change', () => {
    const base = stored(placement)
    const update = updateFrom(placement, base, (doc) =>
      doc.getMap(PROPOSALS_KEY).set('stray', {
        anchor: { quote: { exact: quoted(TEXT_ANCHOR_QUOTE_MAX_CHARS + 1) } },
      }),
    )
    expect(judged(base, update)).toBeNull()
  })
})

it('answers a quote breach with its own refusal code', () => {
  expect(SYNC_TEXT_BREACH_CODES['anchor-quote']).toBe('anchor_quote_too_long')
})
