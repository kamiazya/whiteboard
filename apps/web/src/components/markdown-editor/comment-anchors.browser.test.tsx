// The markdown editor's in-place projection of the annotation layer
// (ADR-0026 decision 5): a thread's passage is highlighted in the source
// and marked in the gutter, the marker opens the conversation, and the
// passage keeps its place while the text around it is edited.
import type { CommentThread } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(cleanup)

const BODY = ['# Plan', '', 'Ship the rail by Friday, then rest.', '', 'Nothing else.'].join('\n')

const at = (needle: string) => BODY.indexOf(needle)

function thread(
  id: string,
  exact: string,
  status: CommentThread['status'] = 'open',
): CommentThread {
  return {
    id,
    anchor: { kind: 'text', quote: { exact }, start: at(exact), end: at(exact) + exact.length },
    status,
    messages: [{ id: `${id}-m1`, body: `about ${exact}`, createdAt: '2026-09-02T00:00:00.000Z' }],
  }
}

function highlighted(): string[] {
  return Array.from(document.querySelectorAll('.cm-comment-anchor')).map(
    (el) => el.textContent ?? '',
  )
}

it('highlights each thread’s passage and marks its line in the gutter', async () => {
  render(
    <MarkdownEditor
      value={BODY}
      onChange={vi.fn()}
      initialViewMode="write"
      threads={[thread('t1', 'by Friday'), thread('t2', 'Nothing else', 'resolved')]}
    />,
  )
  await vi.waitFor(() => expect(highlighted()).toEqual(['by Friday', 'Nothing else']))
  const markers = page.getByTestId('comment-gutter-marker')
  await expect.element(markers.first()).toBeInTheDocument()
  expect(markers.all()).toHaveLength(2)
  expect(document.querySelector('.cm-comment-anchor-resolved')?.textContent).toBe('Nothing else')
})

it('a press on the marker opens that conversation', async () => {
  const onSelectThread = vi.fn()
  render(
    <MarkdownEditor
      value={BODY}
      onChange={vi.fn()}
      initialViewMode="write"
      threads={[thread('t1', 'by Friday')]}
      onSelectThread={onSelectThread}
    />,
  )
  // By test id: CodeMirror's gutter is aria-hidden, so the marker has no
  // accessible role to find — the panel is the accessible path.
  const marker = page.getByTestId('comment-gutter-marker')
  await expect.element(marker).toBeInTheDocument()
  expect(marker.element().getAttribute('aria-label')).toBe('Open comment')
  await userEvent.click(marker)
  expect(onSelectThread).toHaveBeenCalledWith('t1')
})

it('the selected conversation is drawn stronger, and only it', async () => {
  const { rerender } = render(
    <MarkdownEditor
      value={BODY}
      onChange={vi.fn()}
      initialViewMode="write"
      threads={[thread('t1', 'by Friday'), thread('t2', 'Nothing else')]}
      selectedThreadId={null}
    />,
  )
  await vi.waitFor(() => expect(highlighted()).toHaveLength(2))
  expect(document.querySelector('.cm-comment-anchor-selected')).toBeNull()
  rerender(
    <MarkdownEditor
      value={BODY}
      onChange={vi.fn()}
      initialViewMode="write"
      threads={[thread('t1', 'by Friday'), thread('t2', 'Nothing else')]}
      selectedThreadId="t2"
    />,
  )
  await vi.waitFor(() =>
    expect(document.querySelector('.cm-comment-anchor-selected')?.textContent).toBe('Nothing else'),
  )
})

it('the passage keeps its place while text is typed above it', async () => {
  render(
    <MarkdownEditor
      value={BODY}
      onChange={vi.fn()}
      initialViewMode="write"
      threads={[thread('t1', 'by Friday')]}
    />,
  )
  await vi.waitFor(() => expect(highlighted()).toEqual(['by Friday']))
  const content = document.querySelector('.cm-content') as HTMLElement
  content.focus()
  await userEvent.keyboard('{Control>}{Home}{/Control}')
  await userEvent.keyboard('New first line. ')
  await vi.waitFor(() => expect(highlighted()).toEqual(['by Friday']))
})

it('a passage that is gone draws nothing, and stays out of the gutter', async () => {
  render(
    <MarkdownEditor
      value={BODY}
      onChange={vi.fn()}
      initialViewMode="write"
      threads={[
        {
          id: 't-gone',
          anchor: { kind: 'text', quote: { exact: 'deleted sentence' }, start: 0, end: 16 },
          status: 'open',
          messages: [{ id: 'm', body: 'about a sentence that is gone' }],
        },
        thread('t1', 'by Friday'),
      ]}
    />,
  )
  await vi.waitFor(() => expect(highlighted()).toEqual(['by Friday']))
  expect(page.getByTestId('comment-gutter-marker').all()).toHaveLength(1)
})
