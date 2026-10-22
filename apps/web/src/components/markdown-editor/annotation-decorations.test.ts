// @vitest-environment node
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
import { EditorState } from '@codemirror/state'
import { type DecorationSet, EditorView } from '@codemirror/view'
import { type CommentThread, DOCUMENT_MAX_OPEN_THREADS } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import {
  annotationDecorations,
  placeThreads,
  setAnnotationProjection,
} from './annotation-decorations.js'

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

describe('the resolved conversations the pane draws', () => {
  // One more resolved conversation than the pane keeps, each over a passage
  // the body holds, started a minute apart so recency is unambiguous.
  const COUNT = DOCUMENT_MAX_OPEN_THREADS + 100
  const quote = (i: number) => `[r${i}]`
  const body = Array.from({ length: COUNT }, (_, i) => quote(i)).join(' ')
  const resolved = Array.from({ length: COUNT }, (_, i) =>
    textThread(`r${i}`, quote(i), body.indexOf(quote(i)), {
      status: 'resolved',
      messages: [
        {
          id: `r${i}-m1`,
          body: 'done',
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        },
      ],
    }),
  )
  const open = textThread('open', quote(0), 0)

  function drawnIds(selectedThreadId: string | null): Set<string> {
    const state = EditorState.create({ doc: body, extensions: [annotationDecorations()] }).update({
      effects: setAnnotationProjection.of({ threads: [open, ...resolved], selectedThreadId }),
    }).state
    const ids = new Set<string>()
    for (const source of state.facet(EditorView.decorations)) {
      const set = typeof source === 'function' ? null : (source as DecorationSet)
      set?.between(0, body.length, (_from, _to, deco) => {
        const id = deco.spec.attributes?.['data-thread-id']
        if (typeof id === 'string') ids.add(id)
      })
    }
    return ids
  }

  it('draws every open one and the most recently active resolved ones', () => {
    const ids = drawnIds(null)
    expect(ids.has('open')).toBe(true)
    expect(ids.has(`r${COUNT - 1}`)).toBe(true)
    expect(ids.has('r0')).toBe(false)
    expect(ids.size).toBe(1 + DOCUMENT_MAX_OPEN_THREADS)
  })

  it('draws an older resolved one when it is the conversation selected', () => {
    expect(drawnIds('r0').has('r0')).toBe(true)
  })
})
