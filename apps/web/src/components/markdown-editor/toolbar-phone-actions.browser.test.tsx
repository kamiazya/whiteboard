/**
 * On a phone the editor shows TWO bars at once — this one under the header,
 * and the keyboard-docked formatting bar — and measured, five of their verbs
 * were the same five: Heading, Bold, Italic, Bullet list, Task. A duplicate
 * costs the scarcest row on the screen and teaches nothing.
 *
 * So while the docked bar is carrying the formatting, this bar carries what
 * that bar does not: the annotation entry, which had no button anywhere and
 * was reachable only through a selection plus the ⋯ catalog. When the docked
 * bar is not there — a desktop, or a phone with the caret outside the editor
 * — the formatting comes back, so nothing is lost by the swap.
 *
 * Real browser: the swap turns on `matchMedia('(pointer: coarse)')` and on
 * the active-editor registry, and the second is only populated by a real
 * focus event from a real CodeMirror view.
 */
import type { CommentThread } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { focusEditable } from '../../test-utils/focus-editable.js'
import { MarkdownEditor } from './MarkdownEditor.js'

const realMatchMedia = window.matchMedia
let coarse = true

beforeEach(() => {
  coarse = true
  window.matchMedia = (query: string) =>
    query === '(pointer: coarse)'
      ? ({
          matches: coarse,
          media: query,
          addEventListener() {},
          removeEventListener() {},
        } as unknown as MediaQueryList)
      : realMatchMedia.call(window, query)
})

afterEach(() => {
  window.matchMedia = realMatchMedia
  cleanup()
})

const BODY = 'Ship the report on Friday.'

function labels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('button')]
    .map((button) => button.getAttribute('aria-label') ?? '')
    .filter(Boolean)
}

async function focusSource(container: HTMLElement) {
  await focusEditable(
    () =>
      container
        .querySelector('[data-testid="markdown-source-pane"]')
        ?.querySelector('[contenteditable="true"]') ?? null,
  )
}

it('gives the caret-holding phone editor a Comment button in place of the verbs the docked bar repeats', async () => {
  const { container } = render(
    <MarkdownEditor value={BODY} onChange={vi.fn()} onComposeThread={vi.fn()} />,
  )
  // Before the caret arrives there is no docked bar, so this one still owns
  // the formatting.
  expect(labels(container)).toContain('Bold')
  await focusSource(container)
  await vi.waitFor(() => expect(labels(container)).toContain('Comment'))
  const shown = labels(container)
  for (const verb of ['Bold', 'Italic', 'Heading', 'Bullet list', 'Task']) {
    expect(shown).not.toContain(verb)
  }
  // The controls that were never the docked bar's stay exactly where they were.
  for (const kept of ['Undo', 'Redo', 'Write', 'Read', 'Editing actions']) {
    expect(shown).toContain(kept)
  }
})

it('keeps the verbs on a fine pointer, where no docked bar exists to repeat them', async () => {
  coarse = false
  const { container } = render(
    <MarkdownEditor value={BODY} onChange={vi.fn()} onComposeThread={vi.fn()} />,
  )
  await focusSource(container)
  const shown = labels(container)
  expect(shown).toContain('Bold')
  expect(shown).not.toContain('Comment')
})

it('offers no Comment button to a host with no annotation layer to open one in', async () => {
  const { container } = render(<MarkdownEditor value={BODY} onChange={vi.fn()} />)
  await focusSource(container)
  await vi.waitFor(() => expect(labels(container)).not.toContain('Bold'))
  expect(labels(container)).not.toContain('Comment')
})

it('opens a conversation about the paragraph the caret is in, with nothing selected', async () => {
  const onComposeThread = vi.fn()
  const { container } = render(
    <MarkdownEditor
      value={`Intro line.\n\n${BODY}`}
      onChange={vi.fn()}
      onComposeThread={onComposeThread}
    />,
  )
  await focusSource(container)
  const button = await vi.waitFor(() => {
    const found = [...container.querySelectorAll('button')].find(
      (one) => one.getAttribute('aria-label') === 'Comment',
    )
    if (found === undefined) throw new Error('no Comment button')
    return found
  })
  button.click()
  expect(onComposeThread).toHaveBeenCalledTimes(1)
  expect(onComposeThread.mock.calls[0]?.[0]).toMatchObject({
    kind: 'text',
    quote: { exact: 'Intro line.' },
  })
})

it('takes the paragraph above when the caret sits on the blank line under it', async () => {
  const onComposeThread = vi.fn()
  const { container } = render(
    <MarkdownEditor
      value={`Intro line.\n\n${BODY}`}
      onChange={vi.fn()}
      onComposeThread={onComposeThread}
    />,
  )
  await focusSource(container)
  await userEvent.keyboard('{Control>}{Home}{/Control}')
  await userEvent.keyboard('{End}{ArrowDown}')
  const button = await vi.waitFor(() => {
    const found = [...container.querySelectorAll('button')].find(
      (one) => one.getAttribute('aria-label') === 'Comment',
    )
    if (found === undefined) throw new Error('no Comment button')
    return found
  })
  button.click()
  expect(onComposeThread.mock.calls[0]?.[0]).toMatchObject({ quote: { exact: 'Intro line.' } })
})

it('is inert on a body with no prose at all, the one case with nothing to be about', async () => {
  const onComposeThread = vi.fn()
  const { container } = render(
    <MarkdownEditor value="" onChange={vi.fn()} onComposeThread={onComposeThread} />,
  )
  await focusSource(container)
  const button = await vi.waitFor(() => {
    const found = [...container.querySelectorAll('button')].find(
      (one) => one.getAttribute('aria-label') === 'Comment',
    )
    if (found === undefined) throw new Error('no Comment button')
    return found
  })
  expect(button.getAttribute('aria-disabled')).toBe('true')
  button.click()
  expect(onComposeThread).not.toHaveBeenCalled()
})

// A 12x12 dot three pixels from the screen edge is what a reader was asked
// to hit to read a conversation — half of WCAG 2.5.8's minimum in each
// dimension, a quarter of its area, and inside the strip the OS keeps for its
// own back gesture. So
// the same press has a thumb-sized path that does not depend on hitting it:
// put the caret in the paragraph, press Comment, and the conversation the
// paragraph already has opens instead of a new one starting.
const EXISTING: CommentThread = {
  id: 'thread-1',
  anchor: { kind: 'text', quote: { exact: 'Intro line.' }, start: 0, end: 11 },
  status: 'open',
  messages: [{ id: 'm1', body: 'Is that right?' }],
}

it("opens the conversation the caret's paragraph already has, instead of starting a second one", async () => {
  const onSelectThread = vi.fn()
  const onComposeThread = vi.fn()
  const { container } = render(
    <MarkdownEditor
      value={`Intro line.\n\n${BODY}`}
      onChange={vi.fn()}
      threads={[EXISTING]}
      onSelectThread={onSelectThread}
      onComposeThread={onComposeThread}
    />,
  )
  await focusSource(container)
  const button = await vi.waitFor(() => {
    const found = [...container.querySelectorAll('button')].find(
      (one) => one.getAttribute('aria-label') === 'Comment',
    )
    if (found === undefined) throw new Error('no Comment button')
    return found
  })
  button.click()
  expect(onSelectThread).toHaveBeenCalledWith('thread-1')
  expect(onComposeThread).not.toHaveBeenCalled()
})

it('still composes from a paragraph no conversation is about', async () => {
  const onSelectThread = vi.fn()
  const onComposeThread = vi.fn()
  const { container } = render(
    <MarkdownEditor
      value={`Intro line.\n\n${BODY}`}
      onChange={vi.fn()}
      threads={[EXISTING]}
      onSelectThread={onSelectThread}
      onComposeThread={onComposeThread}
    />,
  )
  await focusSource(container)
  await userEvent.keyboard('{Control>}{End}{/Control}')
  const button = await vi.waitFor(() => {
    const found = [...container.querySelectorAll('button')].find(
      (one) => one.getAttribute('aria-label') === 'Comment',
    )
    if (found === undefined) throw new Error('no Comment button')
    return found
  })
  button.click()
  expect(onComposeThread).toHaveBeenCalledTimes(1)
  expect(onComposeThread.mock.calls[0]?.[0]).toMatchObject({ quote: { exact: BODY } })
  expect(onSelectThread).not.toHaveBeenCalled()
})

it("follows a thread's LIVE passage when the quote now appears twice, as the gutter does", async () => {
  const onSelectThread = vi.fn()
  const onComposeThread = vi.fn()
  // Two paragraphs quote the same words. Only the live mark says which one
  // the thread is actually on — `resolveTextAnchor` prefers it over matching
  // the quote, which by itself would find the first occurrence.
  const repeated = 'Ship it.\n\nShip it.'
  const ambiguous: CommentThread = {
    id: 'thread-2',
    anchor: { kind: 'text', quote: { exact: 'Ship it.' }, start: 0, end: 8 },
    status: 'open',
    messages: [{ id: 'm1', body: 'Which one?' }],
  }
  const { container } = render(
    <MarkdownEditor
      value={repeated}
      onChange={vi.fn()}
      threads={[ambiguous]}
      threadMarks={new Map([['thread-2', { start: 10, end: 18 }]])}
      onSelectThread={onSelectThread}
      onComposeThread={onComposeThread}
    />,
  )
  await focusSource(container)
  // Caret in the FIRST paragraph, which the live mark says the thread is NOT on.
  await userEvent.keyboard('{Control>}{Home}{/Control}')
  const button = await vi.waitFor(() => {
    const found = [...container.querySelectorAll('button')].find(
      (one) => one.getAttribute('aria-label') === 'Comment',
    )
    if (found === undefined) throw new Error('no Comment button')
    return found
  })
  button.click()
  expect(onSelectThread).not.toHaveBeenCalled()
  expect(onComposeThread).toHaveBeenCalledTimes(1)
})

it('still opens a conversation for a host that can select one but cannot start one', async () => {
  const onSelectThread = vi.fn()
  const { container } = render(
    <MarkdownEditor
      value={`Intro line.\n\n${BODY}`}
      onChange={vi.fn()}
      threads={[EXISTING]}
      onSelectThread={onSelectThread}
    />,
  )
  await focusSource(container)
  const button = await vi.waitFor(() => {
    const found = [...container.querySelectorAll('button')].find(
      (one) => one.getAttribute('aria-label') === 'Comment',
    )
    if (found === undefined) throw new Error('no Comment button')
    return found
  })
  button.click()
  expect(onSelectThread).toHaveBeenCalledWith('thread-1')
})
