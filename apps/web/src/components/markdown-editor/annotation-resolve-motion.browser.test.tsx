/**
 * Resolving a conversation CROSSES its markdown markers to the resolved look,
 * the way the rail's row already crosses.
 *
 * This surface is the opposite of the canvas, measured rather than assumed:
 * the markdown editor is handed every thread including resolved ones, so
 * nothing leaves — the gutter dot and the passage stay and change colour.
 * A leave animation would be wrong here for the same reason a cross would be
 * wrong there.
 *
 * What blocked it was DOM identity, and the three markers did not agree.
 * Measured across one resolve: the CodeMirror gutter dot was REPLACED
 * (`same-element=false`), so nothing could transition on it; its
 * `.cm-gutterElement` wrapper was the same element throughout; and the
 * preview marker was reused by React key but carried no resolved state at
 * all, so a reader in Read mode could not tell an open conversation from a
 * closed one.
 *
 * Real browser: a computed `transition-duration` and element identity are
 * both claims jsdom cannot make.
 */
import type { CommentThread } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(cleanup)

const BODY = ['# The plan', '', 'First paragraph, which opens the document.', ''].join('\n')
const EXACT = 'First paragraph'

function thread(status: 'open' | 'resolved'): CommentThread {
  const start = BODY.indexOf(EXACT)
  return {
    id: 't1',
    anchor: { kind: 'text', quote: { exact: EXACT }, start, end: start + EXACT.length },
    status,
    messages: [{ id: 'm1', body: 'why Friday?' }],
  }
}

const view = (status: 'open' | 'resolved') => (
  <MarkdownEditor
    value={BODY}
    onChange={vi.fn()}
    initialViewMode="split"
    previewDebounceMs={0}
    threads={[thread(status)]}
  />
)

const gutterDot = () => document.querySelector('.cm-annotation-gutter-marker')
const previewMarker = () => document.querySelector('[data-testid="comment-preview-marker"]')

async function resolveOne() {
  const { rerender } = render(view('open'))
  await vi.waitFor(() => expect(gutterDot()).not.toBeNull(), { timeout: 4000 })
  await vi.waitFor(() => expect(previewMarker()).not.toBeNull(), { timeout: 4000 })
  const before = { gutter: gutterDot(), preview: previewMarker() }
  rerender(view('resolved'))
  return before
}

describe('the source pane gutter on resolve', () => {
  it('keeps the same dot and crosses it, instead of swapping in a new one', async () => {
    const before = await resolveOne()
    await vi.waitFor(
      () =>
        expect(
          gutterDot()
            ?.closest('.cm-gutterElement')
            ?.classList.contains('cm-annotation-resolved-line'),
        ).toBe(true),
      { timeout: 4000 },
    )
    // Identity is the whole claim: a replaced element has no value to
    // transition FROM, which is why the state moved onto the wrapper
    // CodeMirror keeps.
    expect(gutterDot()).toBe(before.gutter)
  })

  it('declares the crossing on the dot, so the colour is not a cut', async () => {
    await resolveOne()
    const dot = gutterDot()?.querySelector('.cm-annotation-gutter-dot')
    if (dot === null || dot === undefined) throw new Error('no gutter dot')
    expect(getComputedStyle(dot).transitionDuration).not.toBe('0s')
  })
})

describe('the preview marker on resolve', () => {
  it('says which state it is in at all, which it did not before', async () => {
    const before = await resolveOne()
    await vi.waitFor(
      () => expect((previewMarker() as HTMLElement | null)?.dataset.status).toBe('resolved'),
      { timeout: 4000 },
    )
    // Reused by React key, so the crossing needs nothing but the class.
    expect(previewMarker()).toBe(before.preview)
    expect(getComputedStyle(previewMarker() as Element).transitionDuration).not.toBe('0s')
  })
})
