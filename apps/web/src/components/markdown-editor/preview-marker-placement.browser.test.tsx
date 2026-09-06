/**
 * A preview marker stands BESIDE the block its conversation is about, and
 * this measures that against where the block actually rendered rather than
 * against the arithmetic that placed it.
 *
 * The reported symptom was markers landing at positions unrelated to any
 * content — in one capture, well below the last line of the document. Every
 * layer under this has its own test and all of them pass, which is what a
 * placement bug looks like when the inputs are individually correct: the
 * marker's `top` is composed from a DOM offset and a laid-out Y, and only a
 * measurement across both can say whether they agree.
 *
 * Ground truth is the SVG's own `<text>` for the quoted words. Not the
 * anchors table the placement reads — using that would be building the
 * oracle out of the code under test.
 */
import type { CommentThread } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(cleanup)

const BODY = [
  '# The plan',
  '',
  'First paragraph, which opens the document.',
  '',
  'Second paragraph, a little further down.',
  '',
  'Third and last, at the bottom.',
].join('\n')

function thread(id: string, exact: string): CommentThread {
  const start = BODY.indexOf(exact)
  return {
    id,
    anchor: { kind: 'text', quote: { exact }, start, end: start + exact.length },
    status: 'open',
    messages: [{ id: `${id}-m`, body: `about ${exact}` }],
  }
}

/**
 * Where the block actually is, read off the rendered SVG. canvas-render
 * lays each line out as its own `<text>`, so the block's top is the top of
 * the first one carrying its words.
 */
function renderedBlockTop(words: string): number {
  const texts = [...document.querySelectorAll('svg text')]
  const found = texts.find((one) => (one.textContent ?? '').includes(words))
  if (found === undefined) {
    throw new Error(`no rendered text for ${words} among ${texts.length} runs`)
  }
  return found.getBoundingClientRect().top
}

function markerTop(threadId: string): number {
  const marker = document.querySelector(
    `[data-testid="comment-preview-marker"][data-thread-id="${threadId}"]`,
  )
  if (marker === null) throw new Error(`no marker for ${threadId}`)
  return marker.getBoundingClientRect().top
}

/**
 * Sized from two measurements in this fixture rather than picked: the
 * residual is 5px (a `<text>`'s box starts at the cap height, a little below
 * the block's own box) and consecutive blocks are 41px apart. Twenty is
 * clear of the first and under half the second, so it passes a correct
 * placement and fails one pointing at a neighbour.
 */
const WITHIN_PX = 20

it('stands each marker beside the block its conversation quotes, measured against the render', async () => {
  render(
    <MarkdownEditor
      value={BODY}
      onChange={vi.fn()}
      initialViewMode="read"
      previewDebounceMs={0}
      threads={[thread('t-first', 'First paragraph'), thread('t-third', 'Third and last')]}
    />,
  )
  await vi.waitFor(() => expect(page.getByTestId('comment-preview-marker').all()).toHaveLength(2), {
    timeout: 4000,
  })

  // Reported together so a failure carries the SIZE and SIGN of the drift
  // for every marker at once, which is what says whether it is a constant
  // offset, a scale, or a per-block error.
  const drift = [
    { thread: 't-first', words: 'First paragraph' },
    { thread: 't-third', words: 'Third and last' },
  ].map(({ thread: id, words }) => ({
    thread: id,
    off: Math.round(markerTop(id) - renderedBlockTop(words)),
  }))

  expect(drift.filter((one) => Math.abs(one.off) > WITHIN_PX)).toEqual([])
})

/**
 * The rule the fix rests on, held mechanically because the defect is one
 * character wide and three other call sites had it.
 *
 * `previewDocumentSvg` exists because a bare `querySelector('svg')` inside
 * the preview column finds a comment MARKER's icon — the markers live in
 * that column, each carries one, and they render before the pane. Every
 * origin measured that way is wrong the moment a document has a
 * conversation on it, and the marker placement was measuring its own
 * previous output.
 *
 * `?raw`, never `node:fs`: apps/web is browser-only and
 * `web-app-boundary.test.ts` enforces it.
 */
const editorSource =
  (
    import.meta.glob('./MarkdownEditor.tsx', {
      query: '?raw',
      eager: true,
      import: 'default',
    }) as Record<string, string>
  )['./MarkdownEditor.tsx'] ?? ''

it('asks for the preview document SVG through one definition, never a bare query', () => {
  // The count proves the scan is reading the file it names, so an empty
  // result cannot be an empty read.
  expect(editorSource.length).toBeGreaterThan(10_000)
  expect(editorSource).toContain('function previewDocumentSvg')

  const bare = editorSource
    .split('\n')
    .map((line, index) => ({ line: line.trim(), at: index + 1 }))
    .filter(({ line }) => /querySelector\((['"`])svg\1\)/.test(line) && !line.startsWith('*'))
  expect(bare).toEqual([])
})
