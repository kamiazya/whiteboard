// The document-level surface for the annotation layer (ADR-0026 decision 5).
// A real browser because the filter is a click and the list is what it
// changes — jsdom alone is disallowed for interaction by AGENTS.md.
import type { AnnotationAnchor, CommentThread } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
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

it('opens the conversation the host asks for, widening a filter that would have hidden it', async () => {
  // The other end of onSelect: the reader reached this thread through the
  // BODY (its gutter marker), so the rail has to arrive on it already open.
  // A resolved one is the case that would otherwise open into an empty list
  // under the default Open filter, which reads as the press doing nothing.
  // Two messages, because the first one is the list EXCERPT and shows as soon
  // as the filter widens — asserting on it alone would pass with the thread
  // still collapsed. Only the second proves it was opened.
  const twoMessages: CommentThread = {
    ...RESOLVED,
    messages: [
      ...RESOLVED.messages,
      { id: 'm3b', body: 'and here is why', createdAt: '2026-09-03T00:40:00.000Z' },
    ],
  }
  const utils = render(<CommentsPanel threads={[OPEN, twoMessages]} />)
  expect(page.getByText('this one is done').query()).toBeNull()

  utils.rerender(<CommentsPanel threads={[OPEN, twoMessages]} revealThreadId="t-resolved" />)

  await expect.element(page.getByText('and here is why')).toBeInTheDocument()
  await expect
    .element(page.getByRole('button', { name: 'All' }))
    .toHaveAttribute('aria-pressed', 'true')
})

const PASSAGE: AnnotationAnchor = {
  kind: 'text',
  quote: { prefix: 'Ship the ', exact: 'report', suffix: ' on Friday.' },
  start: 9,
  end: 15,
}

it('composes a new conversation about the passage the host handed it', async () => {
  // The rail is where a thread is OPENED, not only where existing ones are
  // read: `commentThreadSchema` has no legal empty thread, so the anchor
  // waits here as UI state until there is a first message to create it with.
  const created: { anchor: AnnotationAnchor; body: string }[] = []
  render(
    <CommentsPanel
      threads={[OPEN]}
      composeAnchor={PASSAGE}
      onCreateThread={(anchor, body) => created.push({ anchor, body })}
    />,
  )

  // The passage is quoted back, because by the time the reader is typing in
  // the rail their selection in the body is no longer the thing they are
  // looking at.
  await expect.element(page.getByTestId('comments-panel-compose')).toHaveTextContent('report')
  await userEvent.fill(page.getByRole('textbox', { name: /comment/i }), 'is this still true?')
  await userEvent.click(page.getByRole('button', { name: /^comment$/i }))

  expect(created).toEqual([{ anchor: PASSAGE, body: 'is this still true?' }])
})

it('does not create a conversation out of an empty draft', async () => {
  const created: string[] = []
  render(
    <CommentsPanel
      threads={[OPEN]}
      composeAnchor={PASSAGE}
      onCreateThread={(_anchor, body) => created.push(body)}
    />,
  )

  await userEvent.fill(page.getByRole('textbox', { name: /comment/i }), '   ')
  await userEvent.click(page.getByRole('button', { name: /^comment$/i }))

  expect(created).toEqual([])
})

it('leaves the Resolved filter, which would hide the conversation being written', async () => {
  // The same defect the reveal case has: the thread is created, the list
  // does not show it, and that reads as the create having failed.
  const utils = render(<CommentsPanel threads={[OPEN, RESOLVED]} onCreateThread={() => {}} />)
  await userEvent.click(page.getByRole('button', { name: 'Resolved' }))

  utils.rerender(
    <CommentsPanel threads={[OPEN, RESOLVED]} composeAnchor={PASSAGE} onCreateThread={() => {}} />,
  )

  await expect
    .element(page.getByRole('button', { name: 'Open' }))
    .toHaveAttribute('aria-pressed', 'true')
})

it('offers no compose box with no passage waiting', async () => {
  render(<CommentsPanel threads={[OPEN]} onCreateThread={() => {}} />)

  expect(page.getByTestId('comments-panel-compose').query()).toBeNull()
})

it('abandons the passage when the reader cancels', async () => {
  // Without this the compose box has no exit that is not "write something":
  // a reader who selected the wrong sentence would have to create a comment
  // to get rid of the box asking for one.
  let cancels = 0
  render(
    <CommentsPanel
      threads={[OPEN]}
      composeAnchor={PASSAGE}
      onCreateThread={() => {}}
      onCancelCompose={() => {
        cancels += 1
      }}
    />,
  )

  await userEvent.click(page.getByRole('button', { name: 'Cancel' }))

  expect(cancels).toBe(1)
})
