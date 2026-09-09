/**
 * Reading a conversation and writing the body are two modes, and a press
 * that opens one has to move the reader into it.
 *
 * Until this existed the rail opened beside an editor that still held the
 * caret: the keyboard kept typing into the document, Tab walked the body's
 * own controls, and a reader who had just pressed a gutter marker had no
 * way to reach the conversation they had asked for without the pointer.
 * On a phone that reads as the press having done nothing at all, because
 * the virtual keyboard stays up over the rail that opened.
 *
 * Moving focus is only safe with a way back, so the two arrive together:
 * arrival takes focus, Escape hands it to whatever had it when the
 * conversation was opened.
 *
 * Real browser: `document.activeElement` after a React commit is the whole
 * claim, and jsdom's focus model is not the one the reader has.
 */
import type { AnnotationAnchor, CommentThread } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { CommentsPanel } from './CommentsPanel.js'

afterEach(cleanup)

const OPEN: CommentThread = {
  id: 't-open',
  anchor: { kind: 'spatial', x: 10, y: 20 },
  status: 'open',
  messages: [{ id: 'm1', body: 'tighten the copy here' }],
}

const RESOLVED: CommentThread = {
  id: 't-resolved',
  anchor: { kind: 'spatial', x: 30, y: 40 },
  status: 'resolved',
  messages: [{ id: 'm2', body: 'settled last week' }],
}

const PASSAGE: AnnotationAnchor = {
  kind: 'text',
  quote: { exact: 'Ship the report' },
  start: 0,
  end: 15,
}

it('lands the reader on the conversation the host revealed, not beside it', async () => {
  render(<CommentsPanel threads={[OPEN, RESOLVED]} revealThreadId="t-open" />)
  // The row's own toggle: the conversation's heading, and the place Tab
  // continues from into its verbs, its replies and its reply box.
  const row = page.getByRole('button', { expanded: true })
  await expect.element(row).toHaveFocus()
})

it('follows the host to another conversation rather than staying on the first', async () => {
  const { rerender } = render(<CommentsPanel threads={[OPEN, RESOLVED]} revealThreadId="t-open" />)
  await expect.element(page.getByRole('button', { expanded: true })).toHaveFocus()

  rerender(<CommentsPanel threads={[OPEN, RESOLVED]} revealThreadId="t-resolved" />)
  // Waited on by the ROW, not by the text: an opened conversation draws its
  // opening message as the first entry of its column, so the same words are
  // on screen twice and a text query matches both.
  await expect.element(page.getByRole('button', { expanded: true })).toHaveFocus()
  expect(document.activeElement?.textContent).toContain('settled last week')
})

it('lands in the draft box when the press asked for a NEW conversation', async () => {
  render(<CommentsPanel threads={[OPEN]} composeAnchor={PASSAGE} onCreateThread={vi.fn()} />)
  await expect.element(page.getByRole('textbox', { name: 'Comment' })).toHaveFocus()
})

it('hands focus back on Escape, so the move is a visit and not a trap', async () => {
  const onReturnFocus = vi.fn()
  render(<CommentsPanel threads={[OPEN]} revealThreadId="t-open" onReturnFocus={onReturnFocus} />)
  await expect.element(page.getByRole('button', { expanded: true })).toHaveFocus()

  await userEvent.keyboard('{Escape}')
  expect(onReturnFocus).toHaveBeenCalledTimes(1)
})

it('hands it back from inside the reply box too, where a reader who changed their mind is', async () => {
  const onReturnFocus = vi.fn()
  render(
    <CommentsPanel
      threads={[OPEN]}
      revealThreadId="t-open"
      onReply={vi.fn()}
      onReturnFocus={onReturnFocus}
    />,
  )
  await userEvent.click(page.getByRole('textbox', { name: 'Reply' }))
  await userEvent.keyboard('{Escape}')
  expect(onReturnFocus).toHaveBeenCalledTimes(1)
})

it('cancels an edit in progress instead of leaving, so Escape never discards it twice over', async () => {
  const onReturnFocus = vi.fn()
  render(
    <CommentsPanel
      threads={[OPEN]}
      revealThreadId="t-open"
      onEditMessage={vi.fn()}
      onReturnFocus={onReturnFocus}
    />,
  )
  await userEvent.click(page.getByTestId('edit-m1'))
  await expect.element(page.getByRole('textbox', { name: 'Edit message text' })).toBeInTheDocument()

  await userEvent.keyboard('{Escape}')
  expect(page.getByRole('textbox', { name: 'Edit message text' }).query()).toBeNull()
  // The first Escape closed the editor; leaving the panel is the second.
  expect(onReturnFocus).not.toHaveBeenCalled()
  await userEvent.keyboard('{Escape}')
  expect(onReturnFocus).toHaveBeenCalledTimes(1)
})

it('leaves Escape alone for a host that gave it nowhere to hand focus back to', async () => {
  render(<CommentsPanel threads={[OPEN]} revealThreadId="t-open" />)
  await expect.element(page.getByRole('button', { expanded: true })).toHaveFocus()
  await userEvent.keyboard('{Escape}')
  // Still here, still focused: no host answer is not a reason to drop the
  // reader somewhere unnamed.
  await expect.element(page.getByRole('button', { expanded: true })).toHaveFocus()
})
