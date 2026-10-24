import type { CommentThread } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { CommentsPanel } from './CommentsPanel.js'

afterEach(cleanup)

const OPEN: CommentThread = {
  id: 't-open',
  anchor: { kind: 'document' },
  status: 'open',
  messages: [{ id: 'm1', body: 'tighten the copy' }],
}

it('keeps a polite status region mounted and empty before anything happens', () => {
  render(<CommentsPanel threads={[OPEN]} />)
  const region = screen.getByRole('status')
  expect(region.textContent).toBe('')
  expect(region.getAttribute('aria-live')).toBe('polite')
})

it('announces a resolved conversation, and a reopened one', () => {
  render(<CommentsPanel threads={[OPEN]} onResolve={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: /^Resolve(:|$)/ }))
  expect(screen.getByRole('status').textContent).toBe('Conversation resolved')
  fireEvent.click(screen.getByRole('button', { name: /^Reopen(:|$)/ }))
  expect(screen.getByRole('status').textContent).toBe('Conversation reopened')
})
