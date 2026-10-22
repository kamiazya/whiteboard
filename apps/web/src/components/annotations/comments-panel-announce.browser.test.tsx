/**
 * What a screen-reader reader hears when a write lands. The live region is
 * the only place the outcome of Send exists for them: the draft box that
 * held focus is gone, and the new row is not announced by being added.
 */
import type { AnnotationAnchor } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { CommentsPanel } from './CommentsPanel.js'

afterEach(cleanup)

const PASSAGE: AnnotationAnchor = {
  kind: 'text',
  quote: { exact: 'Ship the report' },
  start: 0,
  end: 15,
}

it('announces a posted comment', async () => {
  render(<CommentsPanel threads={[]} composeAnchor={PASSAGE} onCreateThread={() => {}} />)
  await userEvent.fill(page.getByRole('textbox', { name: 'Comment' }), 'first')
  await userEvent.click(page.getByRole('button', { name: 'Send comment' }))
  await expect.element(page.getByRole('status')).toHaveTextContent('Comment posted')
})

it('announces a sent reply', async () => {
  render(
    <CommentsPanel
      threads={[
        {
          id: 't1',
          anchor: { kind: 'document' },
          status: 'open',
          messages: [{ id: 'm1', body: 'tighten the copy' }],
        },
      ]}
      revealThreadId="t1"
      onReply={() => {}}
    />,
  )
  await userEvent.fill(page.getByRole('textbox', { name: 'Reply' }), 'will do')
  await userEvent.click(page.getByRole('button', { name: 'Send reply' }))
  await expect.element(page.getByRole('status')).toHaveTextContent('Reply sent')
})
