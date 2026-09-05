// The comment verb on a note: the caret's scope becomes a text anchor the
// host receives (quote with its surroundings, plus offsets), from the
// toolbar and from the ⋯ catalog alike, because both read one verb table.
// Without a host seam the verb is offered nowhere — a control that could
// open nothing.
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { focusEditable } from '../../test-utils/focus-editable.js'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(cleanup)

const BODY = 'ship the plan by friday'

it('the toolbar’s Comment hands the host the anchor for the caret’s word', async () => {
  const onRequestComment = vi.fn(() => true)
  render(
    <MarkdownEditor
      value={BODY}
      onChange={vi.fn()}
      initialViewMode="write"
      onRequestComment={onRequestComment}
    />,
  )
  const content = document.querySelector('.cm-content') as HTMLElement
  await focusEditable(() => content)
  await userEvent.keyboard('{Control>}{Home}{/Control}')
  await userEvent.keyboard('{ArrowRight}'.repeat(10))

  await userEvent.click(page.getByRole('button', { name: 'Comment', exact: true }))

  expect(onRequestComment).toHaveBeenCalledWith({
    kind: 'text',
    quote: { prefix: 'ship the ', exact: 'plan', suffix: ' by friday' },
    start: 9,
    end: 13,
  })
})

it('with no host seam the verb is offered nowhere', async () => {
  render(<MarkdownEditor value={BODY} onChange={vi.fn()} initialViewMode="write" />)
  await expect.element(page.getByRole('button', { name: 'Bold' })).toBeInTheDocument()
  expect(page.getByRole('button', { name: 'Comment', exact: true }).query()).toBeNull()
})
