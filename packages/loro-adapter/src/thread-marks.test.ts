// The live half of an annotation's anchor. Every expectation here was
// measured against loro-crdt before it was written down — see the module's
// own notes for the numbers.
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { writeCommentThread } from './comment-threads.js'
import { writeMarkdownBody } from './loro-bridge.js'
import type { PassageRange } from './thread-marks.js'
import { markThreadPassages, readThreadMarks, threadStyleKey } from './thread-marks.js'

const BODY = 'Ship the report on Friday. The draft is not written.'
const PASSAGE = 'report on Friday'
const AT = { start: BODY.indexOf(PASSAGE), end: BODY.indexOf(PASSAGE) + PASSAGE.length }

function marked(doc: LoroDoc, threadId: string): string | undefined {
  const range = readThreadMarks(doc).get(threadId)
  return range === undefined
    ? undefined
    : doc.getText('body').toString().slice(range.start, range.end)
}

function markThreadPassage(doc: LoroDoc, threadId: string, range: PassageRange): void {
  markThreadPassages(doc, doc, new Map([[threadId, range]]))
}

function withBody(): LoroDoc {
  const doc = new LoroDoc()
  doc.setPeerId(1)
  writeMarkdownBody(doc, BODY)
  return doc
}

describe('a thread passage marked in the body', () => {
  it('reads back as the range it was written over', () => {
    const doc = withBody()
    markThreadPassage(doc, 't1', AT)
    expect(marked(doc, 't1')).toBe(PASSAGE)
  })

  it('follows an edit above it, which a stored offset cannot', () => {
    const doc = withBody()
    markThreadPassage(doc, 't1', AT)
    writeMarkdownBody(doc, `URGENT: ${BODY}`)
    expect({ quote: marked(doc, 't1'), at: readThreadMarks(doc).get('t1') }).toMatchObject({
      quote: PASSAGE,
      at: { start: AT.start + 'URGENT: '.length },
    })
  })

  it('disappears when its passage is deleted — the orphan signal', () => {
    // What the offsets never gave. A stored start/end still points at a
    // position after the sentence is gone, so a reader cannot tell a moved
    // passage from a deleted one; the mark simply stops existing.
    const doc = withBody()
    markThreadPassage(doc, 't1', AT)
    writeMarkdownBody(doc, BODY.replace(PASSAGE, ''))
    expect(readThreadMarks(doc).has('t1')).toBe(false)
  })

  it('shrinks to what survived a partial deletion', () => {
    const doc = withBody()
    markThreadPassage(doc, 't1', AT)
    writeMarkdownBody(doc, BODY.replace('report ', ''))
    expect(marked(doc, 't1')).toBe('on Friday')
  })

  it('keeps two overlapping conversations apart', () => {
    // The reason a thread gets its own style key. One shared key carrying
    // the thread id as its VALUE loses the overlap to last-writer-wins —
    // measured: the first thread's range was cut short by the second.
    const doc = withBody()
    markThreadPassage(doc, 't1', { start: AT.start, end: AT.start + 6 })
    markThreadPassage(doc, 't2', { start: AT.start + 3, end: AT.start + 12 })
    expect({ t1: marked(doc, 't1'), t2: marked(doc, 't2') }).toMatchObject({
      t1: 'report',
      t2: 'ort on Fr',
    })
  })

  it('is read by a peer that never registered the styles', () => {
    // Configuration is a WRITER's concern. A reader that imported the
    // document still sees every mark, which is what lets a fresh replica
    // render the projection without knowing which threads exist first.
    const doc = withBody()
    markThreadPassage(doc, 't1', AT)

    const reader = new LoroDoc()
    reader.setPeerId(2)
    reader.import(doc.export({ mode: 'snapshot' }))
    expect(marked(reader, 't1')).toBe(PASSAGE)
  })

  it('answers nothing for a body nobody has marked', () => {
    expect([...readThreadMarks(withBody()).keys()]).toEqual([])
  })
})

describe('the style key a thread is marked with', () => {
  it('escapes a character that would abort the wasm, and round-trips it', () => {
    // `annotationIdSchema` is `z.string().min(1)`, so an id an MCP peer
    // supplies can hold anything. A `:` reaches loro as
    // `RuntimeError: unreachable` — an abort, not a catchable throw — so
    // interpolating an id into a key would hand a peer a remote crash.
    const hostile = 'thread:1/2 100%'
    expect(threadStyleKey(hostile)).not.toContain(':')

    const doc = withBody()
    markThreadPassage(doc, hostile, AT)
    expect(marked(doc, hostile)).toBe(PASSAGE)
  })

  it('leaves an ordinary id readable', () => {
    // Percent-encoding rather than base64 so a snapshot dump stays legible
    // for the ids this app actually mints.
    expect(threadStyleKey('01K5ZQ7V8N9WABCDEFGHJKMNPQ')).toBe('comment-01K5ZQ7V8N9WABCDEFGHJKMNPQ')
  })
})

describe('registering the styles a document may mark with', () => {
  it('refuses to write a mark over nothing', () => {
    // An empty range reads back as no mark at all, so writing one would
    // report a success the reader cannot see.
    const doc = withBody()
    markThreadPassage(doc, 't1', { start: 5, end: 5 })
    expect(readThreadMarks(doc).has('t1')).toBe(false)
  })
})

describe('marking passages without the caller registering anything', () => {
  it('marks a thread on a document that registered no styles at all', () => {
    // The registration rule above is a Loro contract, not a decision this
    // codebase makes — and one every call site would otherwise have to
    // remember, with a throw as the reminder. `markThreadPassages` derives
    // the full set itself, from the threads the document already holds plus
    // whatever is being marked now.
    const doc = new LoroDoc()
    doc.setPeerId(1)
    writeMarkdownBody(doc, BODY)

    markThreadPassages(doc, doc, new Map([['t1', AT]]))

    expect(marked(doc, 't1')).toBe(PASSAGE)
  })

  it('marks several passages under one registration', () => {
    // The backfill shape: a document whose threads arrived through a
    // markdown file carries no marks at all, and every one of them is
    // re-derived from its quote in a single pass.
    const doc = new LoroDoc()
    doc.setPeerId(1)
    writeMarkdownBody(doc, BODY)

    markThreadPassages(
      doc,
      doc,
      new Map([
        ['t1', AT],
        ['t2', { start: 0, end: 4 }],
      ]),
    )

    expect({ t1: marked(doc, 't1'), t2: marked(doc, 't2') }).toMatchObject({
      t1: PASSAGE,
      t2: 'Ship',
    })
  })

  it('keeps a mark this document already carries', () => {
    // Registering REPLACES, so a second write that named only the new
    // thread would leave the first key unregistered. The threads the
    // document holds are part of the set for exactly that reason.
    const doc = new LoroDoc()
    doc.setPeerId(1)
    writeMarkdownBody(doc, BODY)
    writeCommentThread(doc, {
      id: 't1',
      anchor: { kind: 'text', quote: { exact: PASSAGE }, start: AT.start, end: AT.end },
      status: 'open',
      messages: [{ id: 'm1', body: 'why Friday?', createdAt: '2026-01-01T00:00:00.000Z' }],
    })
    markThreadPassages(doc, doc, new Map([['t1', AT]]))

    markThreadPassages(doc, doc, new Map([['t2', { start: 0, end: 4 }]]))

    expect({ t1: marked(doc, 't1'), t2: marked(doc, 't2') }).toMatchObject({
      t1: PASSAGE,
      t2: 'Ship',
    })
  })
})
