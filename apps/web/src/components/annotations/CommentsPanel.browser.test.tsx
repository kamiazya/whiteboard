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
  const meta = page.getByTestId('thread-message-count-t-open')
  await expect.element(meta).toBeInTheDocument()
  expect(meta.element().textContent).toContain('2 messages')
})

it('dates a conversation by its LAST message, not the one that started it', async () => {
  // OPEN was started on the 3rd and replied to an hour later. The stamp
  // beside the subject answers "who started this and when"; the row also
  // has to answer "has anything happened", and for a conversation running
  // over days those are different questions with different answers.
  render(<CommentsPanel threads={[OPEN]} />)
  const meta = page.getByTestId('thread-message-count-t-open')
  await expect.element(meta).toBeInTheDocument()
  // The count and a stamp, with the STAMP's identity asserted below rather
  // than its rendering: the label is the reader's local clock, so pinning
  // its text here would pin this runner's timezone.
  expect(meta.element().textContent).toContain('2 messages · ')
  const stamp = meta.element().querySelector('time')
  expect(stamp?.getAttribute('datetime')).toBe('2026-09-03T01:00:00.000Z')
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
  await expect.element(page.getByTestId('comments-panel-empty')).toMatchTextContent(/no open/i)

  cleanup()
  render(<CommentsPanel threads={[]} />)
  await expect.element(page.getByTestId('comments-panel-empty')).toMatchTextContent(/no comments/i)
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
  // looking at. Scoped to the compose box and asserted on the QUOTE, not on
  // the box's concatenated text — which also carries the submit button's
  // label, so the old whole-box assertion only passed on a substring match.
  await expect
    .element(page.getByTestId('comments-panel-compose').getByText('report'))
    .toBeInTheDocument()
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
  expect(page.getByTestId('thread-about-t-open').query()).toBeNull()
})

it('offers to start a conversation about the whole document, and says so on the compose box', async () => {
  // The one anchor with no place on any surface: nothing in an editor can
  // open it, so the list carries the opener — hidden once a box is up.
  let composes = 0
  const utils = render(
    <CommentsPanel
      threads={[OPEN]}
      onCreateThread={() => {}}
      onComposeDocument={() => {
        composes += 1
      }}
    />,
  )
  await userEvent.click(page.getByTestId('comment-on-document'))
  expect(composes).toBe(1)

  utils.rerender(
    <CommentsPanel
      threads={[OPEN]}
      composeAnchor={{ kind: 'document' }}
      onCreateThread={() => {}}
      onComposeDocument={() => {}}
    />,
  )
  await expect
    .element(page.getByTestId('comments-panel-compose-about'))
    .toHaveTextContent('About the whole document')
  expect(page.getByTestId('comment-on-document').query()).toBeNull()
})

it('closes and reopens a conversation from the rail, which is where a note can do it at all', async () => {
  const resolved: [string, boolean][] = []
  const utils = render(
    <CommentsPanel threads={[OPEN]} onResolve={(id, flag) => resolved.push([id, flag])} />,
  )
  await userEvent.click(page.getByText('tighten the copy here'))
  await userEvent.click(page.getByRole('button', { name: 'Resolve' }))
  expect(resolved).toEqual([['t-open', true]])

  // The document answers with the new status; the same row now offers Reopen.
  utils.rerender(
    <CommentsPanel
      threads={[{ ...OPEN, status: 'resolved' }]}
      revealThreadId="t-open"
      onResolve={(id, flag) => resolved.push([id, flag])}
    />,
  )
  await userEvent.click(page.getByRole('button', { name: 'Reopen' }))
  expect(resolved).toEqual([
    ['t-open', true],
    ['t-open', false],
  ])
})

it('rewrites the opening message from the rail, and an unchanged or emptied draft writes nothing', async () => {
  const edits: [string, string, string][] = []
  render(
    <CommentsPanel
      threads={[OPEN]}
      onEditMessage={(threadId, messageId, body) => edits.push([threadId, messageId, body])}
    />,
  )
  await userEvent.click(page.getByText('tighten the copy here'))
  await userEvent.click(page.getByRole('button', { name: 'Edit comment' }))
  const box = page.getByRole('textbox', { name: 'Edit comment text' })
  await expect.element(box).toHaveValue('tighten the copy here')
  await userEvent.fill(box, 'tighten the copy here, and the heading')
  await userEvent.click(page.getByRole('button', { name: 'Save' }))
  expect(edits).toEqual([['t-open', 'm1', 'tighten the copy here, and the heading']])

  await userEvent.click(page.getByRole('button', { name: 'Edit comment' }))
  await userEvent.fill(page.getByRole('textbox', { name: 'Edit comment text' }), '   ')
  await userEvent.click(page.getByRole('button', { name: 'Save' }))
  expect(edits).toHaveLength(1)
  expect(page.getByTestId('comment-edit').query()).toBeNull()
})

it('offers neither verb on a host with no write path', async () => {
  render(<CommentsPanel threads={[OPEN]} />)
  await userEvent.click(page.getByText('tighten the copy here'))
  expect(page.getByRole('button', { name: 'Resolve' }).query()).toBeNull()
  expect(page.getByRole('button', { name: 'Edit comment' }).query()).toBeNull()
})
