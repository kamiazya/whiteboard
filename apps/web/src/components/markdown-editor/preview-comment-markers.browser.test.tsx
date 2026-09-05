// The annotation layer's projection onto the PREVIEW (ADR-0026 decision 5):
// the source pane has a mark and a gutter marker, but a reader in Read mode
// never sees the source, so the preview carries a marker beside the block
// each conversation's passage starts in.
import type { CommentThread } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(cleanup)

const BODY = ['# Plan', '', 'Ship the rail by Friday, then rest.', '', 'Nothing else.'].join('\n')
const at = (needle: string) => BODY.indexOf(needle)
function thread(id: string, exact: string): CommentThread {
  return {
    id,
    anchor: { kind: 'text', quote: { exact }, start: at(exact), end: at(exact) + exact.length },
    status: 'open',
    messages: [{ id: `${id}-m1`, body: `about ${exact}` }],
  }
}

it('marks each conversation beside its block in Read mode, lower passages lower', async () => {
  render(
    <MarkdownEditor
      value={BODY}
      onChange={vi.fn()}
      initialViewMode="read"
      previewDebounceMs={0}
      threads={[thread('t1', 'by Friday'), thread('t2', 'Nothing else')]}
    />,
  )
  const markers = page.getByTestId('comment-preview-marker')
  await vi.waitFor(() => expect(markers.all()).toHaveLength(2))
  const [first, second] = markers.all().map((m) => m.element().getBoundingClientRect().top)
  expect(second).toBeGreaterThan(first as number)
})

it('a press on a preview marker opens that conversation', async () => {
  const onSelectThread = vi.fn()
  render(
    <MarkdownEditor
      value={BODY}
      onChange={vi.fn()}
      initialViewMode="read"
      previewDebounceMs={0}
      threads={[thread('t1', 'by Friday')]}
      onSelectThread={onSelectThread}
    />,
  )
  await expect.element(page.getByRole('button', { name: 'Open comment' })).toBeInTheDocument()
  await userEvent.click(page.getByRole('button', { name: 'Open comment' }))
  expect(onSelectThread).toHaveBeenCalledWith('t1')
})

it('an orphaned conversation gets no preview marker', async () => {
  render(
    <MarkdownEditor
      value={BODY}
      onChange={vi.fn()}
      initialViewMode="read"
      previewDebounceMs={0}
      threads={[
        {
          id: 't-gone',
          anchor: { kind: 'text', quote: { exact: 'deleted sentence' }, start: 0, end: 16 },
          status: 'open',
          messages: [{ id: 'm', body: 'gone' }],
        },
        thread('t1', 'by Friday'),
      ]}
    />,
  )
  await vi.waitFor(() => expect(page.getByTestId('comment-preview-marker').all()).toHaveLength(1))
  expect(page.getByTestId('comment-preview-marker').element().getAttribute('data-thread-id')).toBe(
    't1',
  )
})
