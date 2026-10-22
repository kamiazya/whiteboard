import type { CommentThread } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { CommentsPanel } from './CommentsPanel.js'

afterEach(cleanup)

const LONE: CommentThread = {
  id: 't-lone',
  anchor: { kind: 'document' },
  status: 'open',
  messages: [{ id: 'm1', body: 'tighten the copy', createdAt: '2026-09-03T00:00:00.000Z' }],
}

const PEER: CommentThread = {
  id: 't-peer',
  anchor: { kind: 'document' },
  status: 'open',
  messages: [
    { id: 'm1', body: 'from a peer', author: 'assistant', createdAt: '2026-09-03T00:00:00.000Z' },
  ],
}

it('names the reader as You on a message nobody signed', () => {
  const { container } = render(<CommentsPanel threads={[LONE]} revealThreadId="t-lone" />)
  const entry = container.querySelector('#thread-t-lone li')
  expect(entry?.textContent).toContain('You')
})

it('keeps the name a peer wrote instead of replacing it with You', () => {
  const { container } = render(<CommentsPanel threads={[PEER]} revealThreadId="t-peer" />)
  const entry = container.querySelector('#thread-t-peer li')
  expect(entry?.textContent).toContain('assistant')
  expect(entry?.textContent).not.toContain('You')
})

it('draws an opened lone remark’s stamp once, in the conversation and not also on its row', () => {
  const { container } = render(<CommentsPanel threads={[LONE]} revealThreadId="t-lone" />)
  expect(container.querySelectorAll('li[data-thread-id="t-lone"] time')).toHaveLength(1)
  expect(container.querySelectorAll('#thread-t-lone time')).toHaveLength(1)
})
