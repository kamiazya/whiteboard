/**
 * A resolved conversation shown on the canvas has to read as settled: its
 * card is muted, says so in its header, collapses to the opening message, and
 * offers Reopen as a visible labelled button instead of an icon behind a hover.
 */
import type { CommentThread } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import '../../index.css'
import { CommentThreadCard } from './CommentThreadCard.js'

afterEach(cleanup)

const OPEN: CommentThread = {
  id: 't-open',
  anchor: { kind: 'spatial', x: 10, y: 20 },
  status: 'open',
  messages: [
    { id: 'm1', body: 'is the copy final', createdAt: '2026-09-02T00:00:00.000Z' },
    { id: 'm2', body: 'yes it shipped', createdAt: '2026-09-02T01:00:00.000Z' },
  ],
}
const RESOLVED: CommentThread = { ...OPEN, id: 't-done', status: 'resolved' }

const STYLE = {
  background: 'rgb(255, 247, 224)',
  border: '1px solid rgb(217, 119, 6)',
  borderRadius: 8,
  padding: 8,
} as const

function card(thread: CommentThread) {
  return (
    <CommentThreadCard
      thread={thread}
      box={{ x: 20, y: 20, width: 240, height: 0 }}
      style={STYLE}
      onReply={vi.fn()}
      onResolve={vi.fn()}
      onEditMessage={vi.fn()}
      onClose={vi.fn()}
    />
  )
}

it('labels a resolved card Resolved in its header and keeps Reopen visible', async () => {
  render(card(RESOLVED))
  const dialog = page.getByRole('dialog', { name: 'Comment thread' })
  await expect.element(dialog.getByText('Resolved')).toBeVisible()
  const reopen = dialog.getByRole('button', { name: 'Reopen' })
  await expect.element(reopen).toBeVisible()
  // Text, not a bare glyph: the verb is read where it is pressed.
  expect(reopen.element().textContent).toContain('Reopen')
  expect(Number.parseFloat(getComputedStyle(reopen.element()).opacity)).toBe(1)
})

it('does not label an open card Resolved', async () => {
  render(card(OPEN))
  const dialog = page.getByRole('dialog', { name: 'Comment thread' })
  await expect.element(dialog.getByRole('button', { name: 'Resolve' })).toBeVisible()
  expect(dialog.getByText('Resolved').query()).toBeNull()
})

it('collapses a resolved card to its opening message, without a reply box', async () => {
  render(card(RESOLVED))
  const dialog = page.getByRole('dialog', { name: 'Comment thread' })
  await expect.element(dialog.getByText('Resolved')).toBeVisible()
  expect(dialog.element().querySelectorAll('[data-comment-body]')).toHaveLength(1)
  expect(dialog.getByRole('textbox').query()).toBeNull()
})

it('draws a resolved card in a quieter border than the open one', async () => {
  const { rerender } = render(card(OPEN))
  const open = getComputedStyle(page.getByRole('dialog').element()).borderTopColor
  rerender(card(RESOLVED))
  const done = getComputedStyle(page.getByRole('dialog').element())
  expect(done.borderTopColor).not.toBe(open)
  expect(page.getByRole('dialog').element().getAttribute('data-status')).toBe('resolved')
})
