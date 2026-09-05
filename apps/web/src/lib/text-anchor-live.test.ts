// The live half of the resolution order (ADR-0026). A thread's quote is its
// durable identity; a Loro mark on the body is where the passage IS right
// now, because the CRDT carried the range through every edit that moved it.
//
// These cases are exactly the ones the quote alone gets wrong.
import type { AnnotationAnchor } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import {
  markdownAnchorResolver,
  missingThreadMarks,
  resolveTextAnchor,
  type TextAnchor,
} from './text-anchor.js'

const BODY = 'Ship the report on Friday. Also ship the report on Friday.'
const QUOTE = 'report on Friday'

/** An anchor whose stored offsets point at the FIRST occurrence. */
const anchor: TextAnchor = {
  kind: 'text',
  quote: { exact: QUOTE, prefix: 'Ship the ', suffix: '. Also ship' },
  start: BODY.indexOf(QUOTE),
  end: BODY.indexOf(QUOTE) + QUOTE.length,
}

describe('resolving a text anchor against a live mark', () => {
  it('takes the mark over the quote, because the CRDT tracked the passage', () => {
    // The second occurrence — a place the quote search would never choose
    // for this anchor, since the stored offsets and the context both point
    // at the first. Only the mark knows the reader meant the other one.
    const second = BODY.lastIndexOf(QUOTE)
    expect(resolveTextAnchor(BODY, anchor, { start: second, end: second + QUOTE.length })).toEqual({
      kind: 'placed',
      start: second,
      end: second + QUOTE.length,
    })
  })

  it('takes the mark even where the quote no longer matches the text', () => {
    // Someone edited inside the passage. The quote is now stale and the
    // search would answer `orphaned`; the mark followed the edit and still
    // names the sentence the conversation is about.
    const edited = BODY.replace(QUOTE, 'report on Monday')
    expect(resolveTextAnchor(edited, anchor, { start: 9, end: 25 })).toMatchObject({
      kind: 'placed',
      start: 9,
    })
  })

  it('falls back to the quote when no mark survived', () => {
    // A document that arrived through a markdown file carries no marks at
    // all — the quote is the only thing that crossed. Absent must mean
    // "ask the quote", never "orphaned".
    expect(resolveTextAnchor(BODY, anchor, undefined)).toEqual({
      kind: 'placed',
      start: anchor.start,
      end: anchor.end,
    })
  })
})

describe('the rail badge, told which passages are still marked', () => {
  it('calls a thread placed on its mark alone', () => {
    const gone = BODY.replace(QUOTE, '')
    const resolve = markdownAnchorResolver(gone, new Map([['t1', { start: 0, end: 4 }]]))
    expect(resolve?.({ id: 't1', anchor })).toBe('placed')
  })

  it('still reads the quote for a thread nothing marked', () => {
    const resolve = markdownAnchorResolver(BODY, new Map())
    expect(resolve?.({ id: 't1', anchor })).toBe('placed')
  })

  it('says orphaned when neither the mark nor the quote finds it', () => {
    const resolve = markdownAnchorResolver('nothing like it here', new Map())
    expect(resolve?.({ id: 't1', anchor })).toBe('orphaned')
  })
})

describe('the marks a document is missing', () => {
  const thread = (id: string, anchor: AnnotationAnchor) => ({ id, anchor })

  it('re-derives a passage the quote can still find', () => {
    // The import case. Marks do not travel through a markdown file — the
    // text arrives and every conversation about it has no live anchor —
    // but the quote does, and it is enough to put the mark back.
    expect(missingThreadMarks(BODY, [thread('t1', anchor)], new Map())).toEqual(
      new Map([['t1', { start: BODY.indexOf(QUOTE), end: BODY.indexOf(QUOTE) + QUOTE.length }]]),
    )
  })

  it('leaves a thread that already has one alone', () => {
    // Re-deriving over a live mark would replace the truth with a guess —
    // and would do it on every load, undoing wherever a concurrent edit had
    // carried the passage.
    const held = new Map([['t1', { start: 42, end: 58 }]])
    expect(missingThreadMarks(BODY, [thread('t1', anchor)], held).size).toBe(0)
  })

  it('leaves an orphaned thread unmarked rather than guessing', () => {
    // The passage is gone. A mark over the nearest thing would be a claim
    // the reader cannot check, and would make the thread look placed
    // forever after — which is exactly what ADR-0026 decision 4 forbids.
    expect(
      missingThreadMarks('Nothing like it here.', [thread('t1', anchor)], new Map()).size,
    ).toBe(0)
  })

  it('ignores an anchor that is not about text', () => {
    const spatial: AnnotationAnchor = { kind: 'spatial', x: 10, y: 20, nodeId: 'n1' }
    expect(missingThreadMarks(BODY, [thread('t1', spatial)], new Map()).size).toBe(0)
  })
})
