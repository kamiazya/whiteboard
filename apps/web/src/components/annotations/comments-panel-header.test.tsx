import type { CommentThread } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
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

const DONE: CommentThread = { ...LONE, id: 't-done', status: 'resolved' }

it('says Resolved on a resolved row and not on an open one', () => {
  const { container, getByRole } = render(<CommentsPanel threads={[LONE, DONE]} />)
  fireEvent.click(getByRole('button', { name: 'All' }))
  expect(container.querySelector('[data-testid="thread-resolved-t-done"]')?.textContent).toBe(
    'Resolved',
  )
  expect(container.querySelector('[data-testid="thread-resolved-t-lone"]')).toBeNull()
})

const ON_NODE: CommentThread = {
  id: 't-node',
  anchor: { kind: 'spatial', nodeId: 'n1', x: 0, y: 0 },
  status: 'open',
  messages: [{ id: 'm1', body: 'about the form', createdAt: '2026-09-03T00:00:00.000Z' }],
}

it('names the anchor in a chip on the row, so two rows can be told apart', () => {
  const { container } = render(
    <CommentsPanel
      threads={[ON_NODE, LONE]}
      anchorLabelOf={(anchor) =>
        anchor.kind === 'document' ? 'whole document' : 'on Sign-up form'
      }
    />,
  )
  expect(container.querySelector('[data-testid="thread-about-t-node"]')?.textContent).toBe(
    'on Sign-up form',
  )
  expect(container.querySelector('[data-testid="thread-about-t-lone"]')?.textContent).toBe(
    'whole document',
  )
})

it('offers no canvas toggle when the host cannot show resolved conversations', () => {
  const { queryByRole } = render(<CommentsPanel threads={[LONE]} />)
  expect(queryByRole('button', { name: 'Show resolved on canvas' })).toBeNull()
})

it('asks the host to show resolved conversations on the canvas, and to hide them again', () => {
  const calls: boolean[] = []
  const { getByRole, rerender } = render(
    <CommentsPanel
      threads={[LONE]}
      showResolvedOnCanvas={false}
      onShowResolvedOnCanvasChange={(show) => calls.push(show)}
    />,
  )
  const toggle = getByRole('button', { name: 'Show resolved on canvas' })
  expect(toggle.getAttribute('aria-pressed')).toBe('false')
  fireEvent.click(toggle)
  rerender(
    <CommentsPanel
      threads={[LONE]}
      showResolvedOnCanvas
      onShowResolvedOnCanvasChange={(show) => calls.push(show)}
    />,
  )
  expect(
    getByRole('button', { name: 'Show resolved on canvas' }).getAttribute('aria-pressed'),
  ).toBe('true')
  fireEvent.click(getByRole('button', { name: 'Show resolved on canvas' }))
  expect(calls).toEqual([true, false])
})
