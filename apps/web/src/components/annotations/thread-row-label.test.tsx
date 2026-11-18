import type { CommentThread } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { CommentsPanel } from './CommentsPanel.js'

afterEach(cleanup)

const MARKED_UP: CommentThread = {
  id: 't-marked',
  anchor: { kind: 'document' },
  status: 'open',
  messages: [
    {
      id: 'm1',
      body: 'Please **tighten** this `code` and [[other]]',
      createdAt: '2026-09-03T00:00:00.000Z',
    },
  ],
}

// The verb's accessible name must read like the row beside it, which shows the
// plain excerpt; a screen reader would otherwise spell out the markup.
it('names Resolve by the comment as plain text, not by its markdown source', () => {
  const { getByRole } = render(<CommentsPanel threads={[MARKED_UP]} onResolve={() => {}} />)
  const label = getByRole('button', { name: /^Resolve(:|$)/ }).getAttribute('aria-label') ?? ''
  expect(label).toBe('Resolve: Please tighten this code and [[other]]')
})
