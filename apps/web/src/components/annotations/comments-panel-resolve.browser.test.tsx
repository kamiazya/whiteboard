/**
 * Resolve is one labelled target, and the press can be taken back.
 *
 * The status dot used to be the whole control: an unlabelled amber disc with
 * a check that showed on hover. With a conversation open the panel drew two
 * identical ones, and a reader resolved the wrong conversation. Real
 * browser: every claim is a rendered box or text a reader can see.
 */
import type { CommentThread } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import '../../index.css'
import { CommentsPanel } from './CommentsPanel.js'

afterEach(cleanup)

const threadOf = (id: string, body: string, status: CommentThread['status'] = 'open') =>
  ({
    id,
    anchor: { kind: 'spatial', x: 10, y: 20 },
    status,
    messages: [{ id: `${id}-m`, body, createdAt: '2026-09-05T08:00:00.000Z' }],
  }) satisfies CommentThread

function Host({
  initial,
  width = 300,
}: {
  readonly initial: readonly CommentThread[]
  readonly width?: number
}) {
  const [threads, setThreads] = useState(initial)
  return (
    <div style={{ width }}>
      <CommentsPanel
        threads={threads}
        onReply={() => {}}
        anchorLabelOf={() => 'on API Gateway → Order Service'}
        onResolve={(id, resolved) =>
          setThreads((all) =>
            all.map((t) => (t.id === id ? { ...t, status: resolved ? 'resolved' : 'open' } : t)),
          )
        }
      />
    </div>
  )
}

const TWO = [threadOf('t-1', 'tighten the copy here'), threadOf('t-2', 'the Friday date is stale')]

it('prints the verb on the row instead of leaving an unlabelled dot', async () => {
  render(<Host initial={TWO} />)
  const verbs = page.getByRole('button', { name: /^Resolve(:|$)/ })
  expect(verbs.elements()).toHaveLength(2)
  for (const el of verbs.elements()) expect(el.textContent?.trim()).toBe('Resolve')
})

it('offers exactly one Resolve while a conversation is open, and it is inside that conversation', async () => {
  render(<Host initial={TWO} />)
  await userEvent.click(page.getByText('tighten the copy here'))
  const verbs = page.getByRole('button', { name: /^Resolve(:|$)/ }).elements()
  // The collapsed neighbour keeps its own; the expanded one carries it in
  // its conversation rather than twice.
  expect(verbs).toHaveLength(2)
  const inside = verbs.filter((el) => el.closest('#thread-t-1') !== null)
  expect(inside).toHaveLength(1)
  const rowOfOpen = document.querySelector('[data-thread-id="t-1"]') as HTMLElement
  expect(rowOfOpen.querySelectorAll('button[aria-label^="Resolve"]')).toHaveLength(1)
})

it('says Resolved with an Undo, and Undo reopens the conversation', async () => {
  render(<Host initial={TWO} />)
  await userEvent.click(page.getByRole('button', { name: /^Resolve(:|$)/ }).nth(0))
  const notice = document.querySelector('[data-testid="comments-panel-undo"]')
  expect(notice?.textContent).toContain('Resolved')
  await userEvent.click(page.getByRole('button', { name: /^Undo/ }))
  await userEvent.click(page.getByRole('button', { name: 'All' }))
  const row = document.querySelector('[data-thread-id="t-1"]') as HTMLElement
  expect(row.dataset.status).toBe('open')
  expect(page.getByRole('button', { name: /^Undo/ }).query()).toBeNull()
})

it('keeps a two-message row meta on one line at rail width', async () => {
  const busy: CommentThread = {
    ...threadOf('t-3', 'resolved earlier', 'resolved'),
    messages: [
      { id: 'a', body: 'one', createdAt: '2026-09-05T08:00:00.000Z' },
      { id: 'b', body: 'two', createdAt: '2026-09-05T09:00:00.000Z' },
    ],
  }
  render(<Host initial={[busy]} width={240} />)
  await userEvent.click(page.getByRole('button', { name: 'All' }))
  const activity = document.querySelector('[data-testid="thread-message-count-t-3"]') as HTMLElement
  expect(activity.getBoundingClientRect().height).toBeLessThanOrEqual(18)
})

it('names each Resolve for its conversation, and the notice Undo for what it undoes', async () => {
  render(<Host initial={TWO} />)
  const names = page
    .getByRole('button', { name: /^Resolve(:|$)/ })
    .elements()
    .map((el) => el.getAttribute('aria-label'))
  expect(new Set(names).size).toBe(2)
  expect(names[0]).toContain('tighten the copy here')
  await userEvent.click(page.getByRole('button', { name: /^Resolve(:|$)/ }).nth(0))
  await expect.element(page.getByRole('button', { name: 'Undo resolve' })).toBeInTheDocument()
})

it('keeps focus in the rail through Resolve and Undo instead of dropping it to the page', async () => {
  render(<Host initial={TWO} />)
  ;(
    page
      .getByRole('button', { name: /^Resolve(:|$)/ })
      .nth(0)
      .element() as HTMLElement
  ).focus()
  await userEvent.keyboard('{Enter}')
  await expect.element(page.getByRole('button', { name: 'Undo resolve' })).toHaveFocus()
  await userEvent.keyboard('{Enter}')
  await vi.waitFor(() => expect(document.activeElement).not.toBe(document.body))
  expect(document.activeElement?.closest('[data-thread-id="t-1"]')).not.toBeNull()
})
