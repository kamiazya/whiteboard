// The document-level surface for the annotation layer (ADR-0026 decision 5).
// A real browser because the filter is a click and the list is what it
// changes — jsdom alone is disallowed for interaction by AGENTS.md.
import type { CommentThread } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { CommentsPanel } from './CommentsPanel.js'

afterEach(cleanup)

const OPEN: CommentThread = {
  id: 't-open',
  anchor: { kind: 'spatial', x: 10, y: 20 },
  status: 'open',
  messages: [
    { id: 'm1', body: 'tighten the copy here', createdAt: '2026-09-03T00:00:00.000Z' },
    { id: 'm2', body: 'agreed', author: 'assistant', createdAt: '2026-09-03T01:00:00.000Z' },
  ],
}

const RESOLVED: CommentThread = {
  id: 't-resolved',
  anchor: { kind: 'spatial', x: 30, y: 40 },
  status: 'resolved',
  messages: [{ id: 'm3', body: 'this one is done', createdAt: '2026-09-03T00:30:00.000Z' }],
}

const ORPHANED: CommentThread = {
  id: 't-orphan',
  anchor: { kind: 'spatial', nodeId: 'gone', x: 0, y: 0 },
  status: 'open',
  messages: [
    { id: 'm4', body: 'about a node that was deleted', createdAt: '2026-09-03T02:00:00Z' },
  ],
}

it('opens on the conversations that are still open, and says how many messages each holds', async () => {
  render(<CommentsPanel threads={[OPEN, RESOLVED]} />)

  await expect.element(page.getByText('tighten the copy here')).toBeInTheDocument()
  // Resolved is the answer to a different question and is not the default one.
  expect(page.getByText('this one is done').query()).toBeNull()
  // Two messages is a conversation; saying so is what distinguishes it from
  // a lone remark without opening it.
  await expect.element(page.getByTestId('thread-message-count-t-open')).toHaveTextContent('2')
})

it('shows the resolved ones when asked, and everything under All', async () => {
  render(<CommentsPanel threads={[OPEN, RESOLVED]} />)

  await userEvent.click(page.getByRole('button', { name: 'Resolved' }))
  await expect.element(page.getByText('this one is done')).toBeInTheDocument()
  expect(page.getByText('tighten the copy here').query()).toBeNull()

  await userEvent.click(page.getByRole('button', { name: 'All' }))
  await expect.element(page.getByText('tighten the copy here')).toBeInTheDocument()
  await expect.element(page.getByText('this one is done')).toBeInTheDocument()
})

it('lists an orphaned thread rather than hiding it, and marks it as having no place', async () => {
  // ADR-0026 decision 4: deleting the subject of a conversation must not
  // delete the conversation, and the panel is the only surface where a
  // thread with nowhere to be drawn can still be reached.
  render(<CommentsPanel threads={[ORPHANED]} resolveAnchor={() => 'orphaned'} />)

  await expect.element(page.getByText('about a node that was deleted')).toBeInTheDocument()
  await expect.element(page.getByTestId('thread-orphaned-t-orphan')).toBeInTheDocument()
})

it('says which filter emptied the list, rather than showing one blank state for both', async () => {
  render(<CommentsPanel threads={[RESOLVED]} />)

  // Open is the default and this document has none — but it DOES have a
  // conversation, so "no comments yet" would be a lie.
  await expect.element(page.getByTestId('comments-panel-empty')).toHaveTextContent(/no open/i)

  cleanup()
  render(<CommentsPanel threads={[]} />)
  await expect.element(page.getByTestId('comments-panel-empty')).toHaveTextContent(/no comments/i)
})

it('opens a thread onto its whole conversation, not just the line the list shows', async () => {
  // The gap this closes: the list could say "2 messages" and offer no way to
  // read the second one. An MCP peer can reply, so that second message is
  // routinely the ANSWER to the question in the first.
  render(<CommentsPanel threads={[OPEN]} />)

  expect(page.getByText('agreed').query()).toBeNull()
  await userEvent.click(page.getByText('tighten the copy here'))

  await expect.element(page.getByText('agreed')).toBeInTheDocument()
  // Both messages, in the order the thread holds them.
  await expect.element(page.getByText('tighten the copy here')).toBeInTheDocument()
})

it('names the author of a message that has one, and says nothing for a message that does not', async () => {
  // `okfActor` is a bare single-line string with no kind, and this app has no
  // accounts, so there is nothing to infer a human-vs-AI badge FROM. The
  // honest surface is the name when one was written and silence otherwise.
  render(<CommentsPanel threads={[OPEN]} />)
  await userEvent.click(page.getByText('tighten the copy here'))

  await expect.element(page.getByText('assistant')).toBeInTheDocument()
})

it('sends a reply from the opened thread, carrying the thread it belongs to', async () => {
  const replies: { threadId: string; body: string }[] = []
  render(
    <CommentsPanel
      threads={[OPEN]}
      onReply={(threadId, body) => replies.push({ threadId, body })}
    />,
  )
  await userEvent.click(page.getByText('tighten the copy here'))

  await userEvent.fill(page.getByRole('textbox', { name: /reply/i }), 'will do')
  await userEvent.click(page.getByRole('button', { name: /^reply$/i }))

  expect(replies).toEqual([{ threadId: 't-open', body: 'will do' }])
})

it('offers no reply box when the host wired no reply handler', async () => {
  // A host that cannot write (a read-only view, or one with no session)
  // should not show a control that silently does nothing.
  render(<CommentsPanel threads={[OPEN]} />)
  await userEvent.click(page.getByText('tighten the copy here'))

  expect(page.getByRole('textbox', { name: /reply/i }).query()).toBeNull()
})

it('sends on Cmd/Ctrl+Enter here too — the chord the canvas card already answered', async () => {
  // The two hosts share one composer, so a rule one of them gains the
  // other cannot lack; this is the one they had already drifted on.
  const replies: { threadId: string; body: string }[] = []
  render(
    <CommentsPanel
      threads={[OPEN]}
      onReply={(threadId, body) => replies.push({ threadId, body })}
    />,
  )
  await userEvent.click(page.getByText('tighten the copy here'))
  await userEvent.click(page.getByRole('textbox', { name: /reply/i }))
  await userEvent.keyboard('on it')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')

  expect(replies).toEqual([{ threadId: 't-open', body: 'on it' }])
  expect(
    (page.getByRole('textbox', { name: /reply/i }).element() as HTMLTextAreaElement).value,
  ).toBe('')
})

it('a conversation opened by the host is shown expanded, even under a filter that hid it', async () => {
  // The gutter marker on a resolved passage opens THAT thread; a rail still
  // filtered to Open would then show nothing opened, which reads as dead.
  const onOpenThreadChange = vi.fn()
  render(
    <CommentsPanel
      threads={[OPEN, RESOLVED]}
      openThreadId={RESOLVED.id}
      onOpenThreadChange={onOpenThreadChange}
    />,
  )
  await expect.element(page.getByText('this one is done')).toBeInTheDocument()
  expect(
    page
      .getByRole('button', { name: /this one is done/ })
      .element()
      .getAttribute('aria-expanded'),
  ).toBe('true')
  expect(page.getByRole('button', { name: 'All' }).element().getAttribute('aria-pressed')).toBe(
    'true',
  )

  // The host owns the answer: a press reports the change rather than making it.
  await userEvent.click(page.getByText('tighten the copy here'))
  expect(onOpenThreadChange).toHaveBeenCalledWith('t-open')
})

it('says what a thread is about when nothing on a surface can: the document, a node set', async () => {
  const whole: CommentThread = {
    id: 't-doc',
    anchor: { kind: 'document' },
    status: 'open',
    messages: [{ id: 'm5', body: 'is this document still needed?' }],
  }
  const set: CommentThread = {
    id: 't-set',
    anchor: { kind: 'spatial', nodeIds: ['a', 'b', 'c'], x: 0, y: 0, width: 10, height: 10 },
    status: 'open',
    messages: [{ id: 'm6', body: 'these belong together' }],
  }
  render(<CommentsPanel threads={[OPEN, whole, set]} />)
  await expect.element(page.getByTestId('thread-about-t-doc')).toHaveTextContent('whole document')
  await expect.element(page.getByTestId('thread-about-t-set')).toHaveTextContent('3 nodes')
  // A pin says where a spot comment is; the list adds nothing.
  expect(document.querySelector('[data-testid="thread-about-t-open"]')).toBeNull()
})

it('offers to start a conversation about the whole document, when the host can write one', async () => {
  const onDraftDocument = vi.fn()
  render(<CommentsPanel threads={[OPEN]} onDraftDocument={onDraftDocument} />)
  await userEvent.click(page.getByTestId('comment-on-document'))
  expect(onDraftDocument).toHaveBeenCalledTimes(1)
})

it('labels a draft about the document as such, and hides the opener while a draft is up', async () => {
  render(
    <CommentsPanel
      threads={[]}
      onDraftDocument={() => {}}
      draft={{ onSubmit: () => {}, onCancel: () => {} }}
    />,
  )
  await expect
    .element(page.getByTestId('comment-draft-about'))
    .toHaveTextContent('the whole document')
  expect(document.querySelector('[data-testid="comment-on-document"]')).toBeNull()
})
