// The document-level surface for the annotation layer (ADR-0026 decision 5).
// A real browser because the filter is a click and the list is what it
// changes — jsdom alone is disallowed for interaction by AGENTS.md.
import type { AnnotationAnchor, CommentThread } from '@kamiazya/whiteboard-model'
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
  // Both messages, in the order the thread holds them — read out of the
  // opened column rather than off the page, because the row above it
  // carries a summary of the opening message and a bare text query matches
  // that one too.
  const conversation = [...document.querySelectorAll('#thread-t-open [data-comment-body]')].map(
    (node) => node.textContent,
  )
  expect(conversation[0]).toContain('tighten the copy here')
  expect(conversation[1]).toContain('agreed')
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
  await userEvent.click(page.getByRole('button', { name: /send reply/i }))

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
  await userEvent.click(page.getByRole('button', { name: /send comment/i }))

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

  // Two rungs, and both are asserted. The send SAYS it is inert, which is
  // what an icon with no label owes a reader; and the submit handler still
  // guards, so a path that reaches it anyway — the driver refuses to click
  // an aria-disabled control, so this is the raw one — writes nothing.
  const send = page.getByRole('button', { name: /send comment/i })
  await expect.element(send).toHaveAttribute('aria-disabled', 'true')
  ;(send.element() as HTMLElement).click()

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
  //
  // The exit is ESCAPE, not a button. A Cancel drawn as an icon would be an
  // X, which is already the glyph that closes the panel — same shape, two
  // scopes — and the verbs on a conversation are icon-only now.
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

  await expect.element(page.getByRole('textbox', { name: 'Comment' })).toHaveFocus()
  await userEvent.keyboard('{Escape}')

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
  await userEvent.click(page.getByTestId('edit-m1'))
  const box = page.getByRole('textbox', { name: 'Edit message text' })
  // `textContent`, not `toHaveValue`: the box is a CodeMirror view, so what
  // it holds is the text of its rendered lines and not a form value. Still
  // the load-bearing assertion of this test's first half — the editor has
  // to open PRE-FILLED, and an empty one would let the rest pass while
  // rewriting the message from scratch.
  await expect.element(box).toHaveTextContent('tighten the copy here')
  await userEvent.fill(box, 'tighten the copy here, and the heading')
  await userEvent.click(page.getByRole('button', { name: 'Save' }))
  expect(edits).toEqual([['t-open', 'm1', 'tighten the copy here, and the heading']])

  await userEvent.click(page.getByTestId('edit-m1'))
  await userEvent.fill(page.getByRole('textbox', { name: 'Edit message text' }), '   ')
  // Emptying the subject no longer SAVES-as-cancel by accident: Save goes
  // inert, and the way out is Escape — the same key the reply draft and the
  // panel itself answer to.
  const save = page.getByRole('button', { name: 'Save' })
  await expect.element(save).toHaveAttribute('aria-disabled', 'true')
  ;(save.element() as HTMLElement).click()
  expect(edits).toHaveLength(1)

  await userEvent.keyboard('{Escape}')
  expect(page.getByTestId('comment-edit').query()).toBeNull()
})

it('offers neither verb on a host with no write path', async () => {
  render(<CommentsPanel threads={[OPEN]} />)
  await userEvent.click(page.getByText('tighten the copy here'))
  expect(page.getByRole('button', { name: 'Resolve' }).query()).toBeNull()
  expect(page.getByTestId('edit-m1').query()).toBeNull()
})

/**
 * The chord is the whole reason `ReplyComposer` was extracted — its own
 * doc comment names this as the drift it exists to end: "the card
 * submitted on Cmd/Ctrl+Enter and the panel did not, so the same
 * conversation answered the same chord on one surface and swallowed it on
 * the other." Only the CARD was folded onto it; the rail kept its inline
 * copy, so the drift the extraction was written to close is still open.
 */
it('sends a reply on Meta+Enter, the chord every other editing surface in the app answers', async () => {
  const replies: { threadId: string; body: string }[] = []
  render(
    <CommentsPanel
      threads={[OPEN]}
      onReply={(threadId, body) => replies.push({ threadId, body })}
    />,
  )
  await userEvent.click(page.getByText('tighten the copy here'))

  const box = page.getByRole('textbox', { name: /reply/i })
  await userEvent.fill(box, 'on it')
  await userEvent.click(box)
  await userEvent.keyboard('{Meta>}{Enter}{/Meta}')

  expect(replies).toEqual([{ threadId: 't-open', body: 'on it' }])
})

/**
 * A comment's body is markdown, and the rail is where a reader who never
 * opens the canvas meets it. Two surfaces in one row, each with its own
 * job: the row summarises, the expanded conversation shows the message.
 */
it('summarises a markdown body as text in the row and draws it as markdown when opened', async () => {
  const thread: CommentThread = {
    ...OPEN,
    id: 't-md',
    messages: [
      { id: 'm-md', body: '**tighten** the copy here', createdAt: '2026-09-03T00:00:00Z' },
    ],
  }
  render(<CommentsPanel threads={[thread]} />)

  // The row: a button clamped to two lines, so it says what the comment
  // says rather than how it is written. The asterisks are the defect.
  const row = page.getByRole('button', { name: /tighten the copy here/ })
  await expect.element(row).toBeInTheDocument()
  expect((await row.element()).textContent).not.toContain('**')

  await userEvent.click(row)

  // Opened: the message as written, drawn through canvas-render — so the
  // emphasis is its own run rather than four characters of syntax.
  const body = document.querySelector('[data-comment-body] svg')
  expect(body).not.toBeNull()
  const runs = [...(body?.querySelectorAll('text') ?? [])].map((node) => node.textContent)
  expect(runs).toContain('tighten')
})

/**
 * The rail's own box is the note's editor too. Pinned at the rail rather
 * than only on `CommentComposer`, for the reason the parity matrix exists:
 * a cell naming the component's test would say the component works, not
 * that this surface uses it.
 */
it('answers a conversation in a markdown editor, with the editing verbs the note pane has', async () => {
  render(<CommentsPanel threads={[OPEN]} onReply={() => {}} />)
  await userEvent.click(page.getByText('tighten the copy here'))

  const box = page.getByRole('textbox', { name: /reply/i })
  await userEvent.click(box)
  await userEvent.keyboard('later')
  // Shift+Home rather than select-all: Ctrl+A is Cmd+A on a Mac, and
  // `platform-independent-keys.test.ts` bans the chord for exactly the
  // reason this change fixed in the composer itself — a chord that means
  // one thing on Linux and another on a Mac. Ctrl+B stays legal because
  // the composer binds both modifiers.
  await userEvent.keyboard('{Shift>}{Home}{/Shift}')
  await userEvent.keyboard('{Control>}b{/Control}')

  await vi.waitFor(() => expect(box.element().textContent).toBe('**later**'))
})

/**
 * The shape of an opened conversation. Four claims that were all wrong at
 * once on a phone, and each of them is about POSITION rather than content —
 * so they are measured, not read off the DOM.
 *
 * What it looked like: the row's summary started at 54px (a 44px status dot,
 * a 2px gap, 8px of padding) while the replies under it started at 17px,
 * outdented by 37px from the message they answer. Between the two sat the
 * Edit pencil, alone on a 44px row of its own. The reply box and its Send
 * were stacked, leaving a band of nothing to the right of the field.
 */
function rectOf(selector: string): DOMRect {
  const node = document.querySelector(selector)
  if (node === null) throw new Error(`no element for ${selector}`)
  return node.getBoundingClientRect()
}

/** How much of a vertical band two elements share — 0 when stacked. */
function sharedRows(a: DOMRect, b: DOMRect): number {
  return Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
}

it('draws the opening message as the first entry of the opened conversation, every time', async () => {
  // Not only when the row's summary dropped something. A column whose first
  // entry is the opening message on one thread and a REPLY on the next is a
  // column a reader has to re-read to place; `tighten the copy here` is
  // plain, so under the old rule it was drawn nowhere but the row.
  render(<CommentsPanel threads={[OPEN]} />)
  await userEvent.click(page.getByText('tighten the copy here'))

  const bodies = document.querySelectorAll('#thread-t-open [data-comment-body]')
  expect(bodies).toHaveLength(2)
})

it('stands the opened conversation on the same left edge as the row that holds it', async () => {
  render(<CommentsPanel threads={[OPEN]} />)
  await userEvent.click(page.getByText('tighten the copy here'))

  const subject = rectOf('#thread-t-open')
  // The row's own TEXT edge, read off the toggle's content box rather than
  // off the summary span: what the axis has to line up with is where the row
  // writes, which is a fact about the button whatever it currently draws.
  const row = document.querySelector('li[data-thread-id="t-open"] button[aria-expanded]')
  if (row === null) throw new Error('no row')
  const textEdge =
    row.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(row).paddingLeft)
  // One axis: what the row says and what the conversation says line up, so
  // the indent alone tells a reader the messages belong to that dot.
  expect(rectOf('#thread-t-open [data-comment-body]').left).toBeCloseTo(textEdge, 0)
  // And the column hangs INSIDE the row's own text column rather than
  // beside the status dot.
  expect(subject.left).toBeGreaterThan(40)
})

it('carries the grouping in the spacing: further between messages than inside one', async () => {
  // The rhythm claim, stated as the invariant rather than as a number. It
  // was 8px between messages and 2px between a message's stamp and its
  // body — a 4:1 ratio, which reads as one undifferentiated column.
  render(<CommentsPanel threads={[OPEN]} />)
  await userEvent.click(page.getByText('tighten the copy here'))

  const list = document.querySelectorAll('#thread-t-open [data-comment-body]')
  const stamps = document.querySelectorAll('#thread-t-open time')
  expect(list.length).toBeGreaterThanOrEqual(2)
  expect(stamps.length).toBeGreaterThanOrEqual(2)

  const insideOne = list[0]!.getBoundingClientRect().top - stamps[0]!.getBoundingClientRect().bottom
  const betweenTwo =
    stamps[1]!.getBoundingClientRect().top - list[0]!.getBoundingClientRect().bottom
  expect(betweenTwo).toBeGreaterThan(insideOne)
})

it('keeps Edit on the opening message stamp line, not on a row of its own', async () => {
  render(<CommentsPanel threads={[OPEN]} onEditMessage={() => {}} />)
  await userEvent.click(page.getByText('tighten the copy here'))

  // By id: every message carries this verb now, so a query by name matches
  // one per message.
  const edit = (await page.getByTestId('edit-m1').element()).getBoundingClientRect()
  const stamp = rectOf('#thread-t-open time')
  // On the line of the stamp it acts on — a 44px tap target sunk into an
  // 11px row rather than pushing the conversation down by 44px. WHERE on
  // that line is the column claim below; what matters here is that the verb
  // shares a line with its message instead of owning a row.
  expect(edit.left).toBeGreaterThan(stamp.right)
  expect(sharedRows(edit, stamp)).toBeGreaterThan(8)
})

it('puts the reply field and its Send on one line', async () => {
  render(<CommentsPanel threads={[OPEN]} onReply={() => {}} />)
  await userEvent.click(page.getByText('tighten the copy here'))

  const field = (
    await page.getByRole('textbox', { name: /reply/i }).element()
  ).getBoundingClientRect()
  const send = (
    await page.getByRole('button', { name: 'Send reply' }).element()
  ).getBoundingClientRect()
  expect(send.left).toBeGreaterThanOrEqual(field.right - 1)
  expect(sharedRows(field, send)).toBeGreaterThan(8)
})

it('says one time on a closed row, not the opening stamp and the last activity both', async () => {
  // The row answers "how much is in here, and has it moved lately". The
  // opening stamp is the first entry of the column one tap away, and two
  // stamps on an 11px line at 390px is what made the row wrap.
  render(<CommentsPanel threads={[OPEN]} />)
  await expect.element(page.getByTestId('thread-message-count-t-open')).toBeInTheDocument()

  expect(document.querySelectorAll('li[data-thread-id="t-open"] time')).toHaveLength(1)
})

/**
 * One reading size on the surface. The rail's chrome is 11-12px and its
 * message bodies were laid out at the bubble's 16px, so the largest text in
 * the panel was the prose — a third bigger than the row summarising the very
 * same sentence directly above it. The box you type a reply INTO was 12px
 * while the reply it posts drew at 16px.
 */
it('draws a reply at the size the box that wrote it uses', async () => {
  render(<CommentsPanel threads={[OPEN]} onReply={() => {}} />)
  await userEvent.click(page.getByText('tighten the copy here'))

  const field = document.querySelector('#thread-t-open .cm-content')
  const prose = document.querySelector('#thread-t-open [data-comment-body] text')
  if (field === null || prose === null) throw new Error('no field or no prose')
  expect(getComputedStyle(field).fontSize).toBe(getComputedStyle(prose).fontSize)
})

/**
 * A summary is what a CLOSED conversation shows. Once it is open the
 * messages themselves are right there, so drawing the summary above them
 * puts the same sentence on screen twice — and at two sizes, since a row
 * summary is 12px chrome and prose is 14px. The row keeps its identity for
 * a screen reader (it is still the control that collapses this thread) and
 * keeps saying how much is in here; what it stops doing is repeating the
 * first message.
 */
it('stops summarising a conversation that is open, since the messages are right there', async () => {
  render(<CommentsPanel threads={[OPEN]} />)
  const summary = document.querySelector('.comment-row-subject')
  if (summary === null) throw new Error('no summary')
  expect(summary.getBoundingClientRect().width).toBeGreaterThan(20)

  await userEvent.click(page.getByText('tighten the copy here'))

  // Not drawn — but still the row's accessible name, so the control that
  // collapses this conversation is still named by the conversation.
  expect(summary.getBoundingClientRect().width).toBeLessThan(2)
  const row = page.getByRole('button', { expanded: true })
  expect((await row.element()).textContent).toContain('tighten the copy here')

  // And it comes back: the summary is the CLOSED state's job.
  await userEvent.click(row)
  expect(summary.getBoundingClientRect().width).toBeGreaterThan(20)
})

/**
 * The messages carry the weight, not the row above them.
 *
 * `TOGGLE_STATE_CLASS` fills a control that is ON, which is right for a
 * toggle whose effect is somewhere else — the header button that opens this
 * rail has no other way to say so. A DISCLOSURE says it by disclosing: the
 * conversation appears directly under the row, indented and ruled. Filling
 * the row as well made a solid slab out of the one line on screen that is
 * pure chrome, above the prose that is the point.
 */
it('leaves an open row unfilled, since the conversation under it is the state', async () => {
  render(<CommentsPanel threads={[OPEN]} />)
  // Opened WITHOUT moving the pointer: `userEvent.click` drives the real
  // mouse and leaves it parked on the row, so `hover:bg-accent` answers the
  // question this test is asking and the reading says nothing about the
  // open state at all. A bubbled click runs the same handler with the
  // pointer nowhere near.
  const row = document.querySelector('li[data-thread-id="t-open"] button[aria-expanded]')
  if (!(row instanceof HTMLElement)) throw new Error('no row')
  row.click()

  await vi.waitFor(() => expect(row.getAttribute('aria-expanded')).toBe('true'))
  // The pointer is a REAL one and it stays where the last test in this file
  // left it — which, since every test here renders the same panel at the
  // same place, is often this very row. Park it somewhere harmless first or
  // `hover:bg-accent` answers instead, and the test passes alone while
  // failing in its own file.
  await page.getByRole('button', { name: 'All' }).hover()
  expect(getComputedStyle(row).backgroundColor).toBe('rgba(0, 0, 0, 0)')
})

/**
 * A conversation is a list of messages and the first one is not special.
 *
 * The write door has taken a message id from the start
 * (`onEditMessage(threadId, messageId, body)`) and the rail passed
 * `messages[0].id` to it every time, so a reply — the thing a reader most
 * often wants back, since it is the one they just typed — could not be
 * corrected from any surface at all.
 */
it('rewrites any message in a conversation, not only the one that opened it', async () => {
  const edits: { threadId: string; messageId: string; body: string }[] = []
  render(
    <CommentsPanel
      threads={[OPEN]}
      onEditMessage={(threadId, messageId, body) => edits.push({ threadId, messageId, body })}
    />,
  )
  await userEvent.click(page.getByText('tighten the copy here'))

  await userEvent.click(page.getByTestId('edit-m2'))
  await userEvent.fill(page.getByRole('textbox', { name: 'Edit message text' }), 'agreed, and done')
  await userEvent.click(page.getByRole('button', { name: 'Save' }))

  expect(edits).toEqual([{ threadId: 't-open', messageId: 'm2', body: 'agreed, and done' }])
})

it('offers the same verb on every message, so none of them is the special one', async () => {
  render(<CommentsPanel threads={[OPEN]} onEditMessage={() => {}} />)
  await userEvent.click(page.getByText('tighten the copy here'))

  const verbs = document.querySelectorAll('#thread-t-open [data-testid^="edit-"]')
  expect(verbs).toHaveLength(OPEN.messages.length)
})

it('rewrites one message at a time, leaving the rest of the conversation readable', async () => {
  // Two editors open at once would be two drafts of one conversation, and
  // the Escape that leaves an edit could only unwind one of them.
  render(<CommentsPanel threads={[OPEN]} onEditMessage={() => {}} />)
  await userEvent.click(page.getByText('tighten the copy here'))

  await userEvent.click(page.getByTestId('edit-m1'))
  await userEvent.click(page.getByTestId('edit-m2'))

  expect(document.querySelectorAll('[data-testid="comment-edit"]')).toHaveLength(1)
})

/**
 * The verbs line up in a column.
 *
 * Beside its stamp is where this started, and with ONE message that was
 * right — pushed to the trailing edge of a full-width message the pencil
 * stood 239px from the only other thing on its line, and what it edited was
 * a guess. Every message carries one now, and the stamps are different
 * widths (`4s ago` against `9/5 21:29`), so following the stamp put the
 * verbs at four different x positions down one short column. A column of
 * per-row actions at the trailing edge is what a reader already knows from
 * every list of rows with actions on them, and the row it belongs to is
 * said by the line it shares.
 */
it('lines the message verbs up in one column rather than following each stamp', async () => {
  const wide: CommentThread = {
    ...OPEN,
    id: 't-wide',
    messages: [
      // Stamps of deliberately different widths: an absolute date for the
      // old one, a relative label for the fresh one.
      { id: 'w1', body: 'started this a while back', createdAt: '2026-01-02T03:04:00.000Z' },
      { id: 'w2', body: 'answered just now', createdAt: new Date().toISOString() },
    ],
  }
  render(<CommentsPanel threads={[wide]} onEditMessage={() => {}} />)
  await userEvent.click(page.getByText('started this a while back'))

  const verbs = [...document.querySelectorAll('#thread-t-wide [data-testid^="edit-"]')].map(
    (node) => node.getBoundingClientRect(),
  )
  expect(verbs).toHaveLength(2)
  const stamps = [...document.querySelectorAll('#thread-t-wide time')].map((node) =>
    node.getBoundingClientRect(),
  )
  // The stamps really do differ, or this test would pass over the defect.
  expect(Math.abs((stamps[0]?.width ?? 0) - (stamps[1]?.width ?? 0))).toBeGreaterThan(4)
  // The verbs do not.
  expect(verbs[1]?.left ?? 0).toBeCloseTo(verbs[0]?.left ?? 0, 0)
  // And each still shares the line of the stamp it acts on.
  expect(sharedRows(verbs[0]!, stamps[0]!)).toBeGreaterThan(8)
  expect(sharedRows(verbs[1]!, stamps[1]!)).toBeGreaterThan(8)
})
