/**
 * The rail draws its object verbs the way DESIGN.md's "Object-action surfaces
 * are icon-first" already says, and the way the canvas card already did.
 *
 * The rule was written and the rail was never held to it: the SAME four verbs
 * rendered icon-only with an `aria-label` on the card (`CardAction`) and as
 * icon + label here. Two presentations of one conversation, and nothing was
 * red, because the annotation parity matrix checks which capabilities a
 * surface HAS and not how it draws them.
 *
 * Two halves ship together and the second is load-bearing: dropping the
 * labels while leaving the padding takes the width the label was giving the
 * target and gives nothing back. The rule specifies 44px and that is what is
 * asserted here.
 *
 * The status dot is the Resolve toggle rather than a picture beside one. One
 * object holds the state and changes it, so a press lands on the thing that
 * then changes — which is also what makes the resolve transition legible,
 * measured in a real browser before it was designed.
 *
 * Real browser: every claim is a computed box or an accessible name.
 */
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
  messages: [{ id: 'm1', body: 'tighten the copy here' }],
}

const DONE: CommentThread = { ...OPEN, id: 't-done', status: 'resolved' }

/** WCAG 2.5.8's minimum, which is also the size the rule names. */
const MIN_TARGET = 44

function box(el: Element) {
  const r = el.getBoundingClientRect()
  return { w: Math.round(r.width), h: Math.round(r.height) }
}

it('draws the conversation verbs icon-only, with the name spoken rather than printed', async () => {
  render(<CommentsPanel threads={[OPEN]} onResolve={vi.fn()} onEditMessage={vi.fn()} />)
  await userEvent.click(page.getByText('tighten the copy here'))

  for (const name of ['Resolve', 'Edit comment']) {
    const el = page.getByRole('button', { name }).element()
    // A name it has; a label it draws. "No visible text" is a visual
    // statement only — the accessible name is non-negotiable.
    expect(el.textContent?.trim()).toBe('')
    expect(el.getAttribute('title')).toBe(name)
  }
})

it('gives every verb the 44px the rule names, which is the half that must not be dropped', async () => {
  render(<CommentsPanel threads={[OPEN]} onResolve={vi.fn()} onEditMessage={vi.fn()} />)
  await userEvent.click(page.getByText('tighten the copy here'))

  // Reported as one object so a failure names WHICH verb is short and by how
  // much, rather than a bare "expected 22 to be >= 44".
  const undersized = ['Resolve', 'Edit comment']
    .map((name) => ({ name, ...box(page.getByRole('button', { name }).element()) }))
    .filter((one) => one.w < MIN_TARGET || one.h < MIN_TARGET)
  expect(undersized).toEqual([])
})

it('makes the status dot the Resolve toggle, reachable without opening the conversation', async () => {
  const resolved: [string, boolean][] = []
  render(<CommentsPanel threads={[OPEN]} onResolve={(id, flag) => resolved.push([id, flag])} />)
  // Collapsed: no row has been opened, and the verb is already there.
  expect(page.getByRole('button', { expanded: true }).query()).toBeNull()
  await userEvent.click(page.getByRole('button', { name: 'Resolve' }))
  expect(resolved).toEqual([['t-open', true]])
})

it('shows which state each conversation is in, on the row, without opening it', async () => {
  render(<CommentsPanel threads={[OPEN, DONE]} onResolve={vi.fn()} />)
  await userEvent.click(page.getByRole('button', { name: 'All' }))
  const open = page.getByRole('button', { name: 'Resolve' }).element()
  const done = page.getByRole('button', { name: 'Reopen' }).element()
  expect(open.querySelector('.annotation-dot')?.getAttribute('data-status')).toBe('open')
  expect(done.querySelector('.annotation-dot')?.getAttribute('data-status')).toBe('resolved')
})

it('keeps the toggle a SIBLING of the row, never nested inside it', async () => {
  // A button inside a button is invalid and collapses the accessibility
  // tree — the row used to be the `<button aria-expanded>` that everything
  // else sat in, so merging the dot into it had to restructure the row.
  render(<CommentsPanel threads={[OPEN]} onResolve={vi.fn()} />)
  const toggle = page.getByRole('button', { name: 'Resolve' }).element()
  expect(toggle.closest('button[aria-expanded]')).toBeNull()
  expect(page.getByRole('button', { expanded: false }).query()).not.toBeNull()
})

it('leaves the dot un-pressable, and still shown, for a host with no write path', async () => {
  render(<CommentsPanel threads={[OPEN]} />)
  expect(page.getByRole('button', { name: 'Resolve' }).query()).toBeNull()
  // The STATE is not a write, so it is still drawn.
  expect(document.querySelector('.annotation-dot')).not.toBeNull()
})

it('cancels a draft with Escape, which is why the Cancel button is gone', async () => {
  const onCancelCompose = vi.fn()
  const onReturnFocus = vi.fn()
  render(
    <CommentsPanel
      threads={[]}
      composeAnchor={{ kind: 'document' }}
      onCreateThread={vi.fn()}
      onCancelCompose={onCancelCompose}
      onReturnFocus={onReturnFocus}
    />,
  )
  await expect.element(page.getByRole('textbox', { name: 'Comment' })).toHaveFocus()
  // An X on Cancel collides with the X that closes the panel — same glyph,
  // two scopes — so the button goes and the key that already meant this
  // carries it.
  expect(page.getByRole('button', { name: /^cancel$/i }).query()).toBeNull()
  await userEvent.keyboard('{Escape}')
  expect(onCancelCompose).toHaveBeenCalledTimes(1)
  // And hands focus back in the same press: the draft box is what focus was
  // moved TO, so taking it away without returning focus drops the reader on
  // the body with no way back to their caret.
  expect(onReturnFocus).toHaveBeenCalledTimes(1)
})

it('shows an icon-only send as inert until there is something to send', async () => {
  const onCreateThread = vi.fn()
  render(
    <CommentsPanel
      threads={[]}
      composeAnchor={{ kind: 'document' }}
      onCreateThread={onCreateThread}
    />,
  )
  const send = page.getByRole('button', { name: 'Send comment' })
  // Guarded on submit rather than disabled, so the keyboard path takes the
  // same rule — but with no label to read, a press that does nothing has to
  // say why before it is pressed.
  await expect.element(send).toHaveAttribute('aria-disabled', 'true')
  // A raw `.click()` rather than `userEvent`: the driver refuses to click an
  // `aria-disabled` control at all, which is the inert state reading exactly
  // as intended — and would leave the GUARD behind it unexercised. This runs
  // the submit the way a keyboard or an assistive tech could.
  ;(send.element() as HTMLElement).click()
  expect(onCreateThread).not.toHaveBeenCalled()

  await userEvent.fill(page.getByRole('textbox', { name: 'Comment' }), 'why Friday?')
  await expect.element(send).toHaveAttribute('aria-disabled', 'false')
  await userEvent.click(send)
  expect(onCreateThread).toHaveBeenCalledTimes(1)
})
