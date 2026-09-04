/**
 * The source pane's half of the annotation layer: which passages of the body
 * a conversation is drawn over, and what happens to one whose passage is
 * gone.
 *
 * The placement is tested apart from CodeMirror because it is the part that
 * can be WRONG — a range is a pair of offsets into text, and an off-by-one
 * puts the highlight over the wrong words. Whether the resulting decoration
 * reaches the DOM is UI wiring, and that is what the browser test beside this
 * one is for.
 */
import type { CommentThread } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { placeThreads } from './annotation-decorations.js'

function textThread(
  id: string,
  exact: string,
  start: number,
  overrides: Partial<CommentThread> = {},
): CommentThread {
  return {
    id,
    anchor: { kind: 'text', quote: { exact }, start, end: start + exact.length },
    status: 'open',
    messages: [{ id: `${id}-m1`, body: 'why this?' }],
    ...overrides,
  }
}

const BODY = 'The report is due on Friday, and the draft is not written.'

describe('placeThreads', () => {
  it('places a thread over the passage its anchor quotes', () => {
    const at = BODY.indexOf('due on Friday')
    expect(placeThreads(BODY, [textThread('t1', 'due on Friday', at)])).toEqual([
      { threadId: 't1', status: 'open', from: at, to: at + 'due on Friday'.length },
    ])
  })

  it('re-finds a passage the stored offsets no longer point at', () => {
    // A sentence inserted above moves every offset below it. The stored
    // `start` is stale; the quote is what still holds.
    const edited = `Note from standup.\n${BODY}`
    expect(
      placeThreads(edited, [textThread('t1', 'due on Friday', BODY.indexOf('due on Friday'))]),
    ).toEqual([
      {
        threadId: 't1',
        status: 'open',
        from: edited.indexOf('due on Friday'),
        to: edited.indexOf('due on Friday') + 'due on Friday'.length,
      },
    ])
  })

  it('places nothing for a thread whose passage is gone', () => {
    expect(
      placeThreads('Rewritten from scratch.', [textThread('t1', 'due on Friday', 21)]),
    ).toEqual([])
  })

  it('places nothing for a spatial anchor, which is about a surface this document has not got', () => {
    const spatial: CommentThread = {
      id: 't1',
      anchor: { kind: 'spatial', x: 10, y: 20 },
      status: 'open',
      messages: [{ id: 'm1', body: 'over here' }],
    }
    expect(placeThreads(BODY, [spatial])).toEqual([])
  })

  it('keeps a resolved thread, saying so, rather than dropping it', () => {
    // The rail's filter decides whether a resolved conversation is SHOWN;
    // dropping it here would mean the body could never show one even when
    // the reader asked for it.
    const at = BODY.indexOf('draft')
    const placed = placeThreads(BODY, [textThread('t1', 'draft', at, { status: 'resolved' })])
    expect(placed).toEqual([{ threadId: 't1', status: 'resolved', from: at, to: at + 5 }])
  })

  it('orders by position, so a range set can be built from it directly', () => {
    const later = BODY.indexOf('draft')
    const earlier = BODY.indexOf('report')
    const placed = placeThreads(BODY, [
      textThread('late', 'draft', later),
      textThread('early', 'report', earlier),
    ])
    expect(placed.map((p) => p.threadId)).toEqual(['early', 'late'])
  })
})
