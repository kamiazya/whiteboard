import type { CommentThread } from '@kamiazya/whiteboard-model'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MessageBy, ThreadActivity } from './message-meta.js'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-05T10:00:00.000Z'))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('stamps a fresh message by its age, the way every other stamp in the app reads', () => {
  render(<MessageBy message={{ id: 'm', body: 'x', createdAt: '2026-09-05T08:00:00.000Z' }} />)
  expect(screen.getByText('2h ago')).not.toBeNull()
})

it('stamps an older message in the READER’S clock, not UTC, keeping the original machine-readable', () => {
  const iso = '2026-09-01T15:04:00.000Z'
  render(<MessageBy message={{ id: 'm', body: 'x', createdAt: iso }} />)
  // The platform's own local-time getters are the expectation: whatever
  // zone this runner sits in, the label must agree with them.
  const local = new Date(iso)
  const two = (n: number) => String(n).padStart(2, '0')
  const expected = `${local.getMonth() + 1}/${local.getDate()} ${two(local.getHours())}:${two(local.getMinutes())}`
  const time = screen.getByText(expected)
  expect(time.tagName).toBe('TIME')
  expect(time.getAttribute('datetime')).toBe(iso)
})

it('renders nothing at all for a message with neither author nor stamp', () => {
  const { container } = render(<MessageBy message={{ id: 'm', body: 'x' }} />)
  expect(container.childElementCount).toBe(0)
})

function threadOf(messages: CommentThread['messages']): CommentThread {
  return { id: 't-1', anchor: { kind: 'document' }, status: 'open', messages }
}

it('says how much a conversation holds and when it last moved, which the subject line cannot', () => {
  render(
    <ThreadActivity
      thread={threadOf([
        { id: 'm1', body: 'is this right?', createdAt: '2026-09-01T10:00:00.000Z' },
        { id: 'm2', body: 'no', createdAt: '2026-09-05T08:00:00.000Z' },
        { id: 'm3', body: 'fixed', createdAt: '2026-09-05T09:30:00.000Z' },
      ])}
    />,
  )
  // The NEWEST stamp, not the opening message's: the row already carries
  // that one beside the subject, and "started three weeks ago" is the wrong
  // answer to "has anything happened".
  expect(screen.getByText(/3 messages/)).not.toBeNull()
  expect(screen.getByText(/30m ago/)).not.toBeNull()
})

it('says nothing for a lone remark, whose one stamp the subject line already carries', () => {
  const { container } = render(
    <ThreadActivity
      thread={threadOf([{ id: 'm1', body: 'one remark', createdAt: '2026-09-05T08:00:00.000Z' }])}
    />,
  )
  expect(container.childElementCount).toBe(0)
})

it('counts an unstamped conversation without inventing a time for it', () => {
  // A browser-kept workspace need not have written a clock into the record.
  // The count is still the useful half, and the stamp is simply absent.
  render(
    <ThreadActivity
      thread={threadOf([
        { id: 'm1', body: 'is this right?' },
        { id: 'm2', body: 'no' },
      ])}
    />,
  )
  expect(screen.getByText('2 messages')).not.toBeNull()
})
