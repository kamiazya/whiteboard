// The failure this helper exists to survive, made deterministic: CI kept
// printing `expected <body> … to be <div …>` from focus waits while the same
// files passed on any idle machine. The mechanism is spec'd, not timing —
// `focus()` on a disconnected element is a no-op — so it can be pinned by
// detaching on purpose instead of hoping a loaded run swaps the contentDOM
// at the right moment.

import { afterEach, describe, expect, it } from 'vitest'
import { focusEditable } from './focus-editable.js'

afterEach(() => {
  document.body.replaceChildren()
})

function editableDiv(): HTMLElement {
  const el = document.createElement('div')
  el.contentEditable = 'true'
  document.body.appendChild(el)
  return el
}

describe('focusEditable', () => {
  it('focuses what the resolver answers', async () => {
    const el = editableDiv()

    await focusEditable(() => el)

    expect(document.activeElement).toBe(el)
  })

  it('follows a swap: the node grabbed at mount is replaced before focus', async () => {
    // What a loaded run does to a `const editable = …querySelector(…)` taken
    // right after render(): the editor re-creates its contentDOM and the held
    // node goes stale. A resolver re-queries, so it follows.
    const first = editableDiv()
    first.remove()
    const second = editableDiv()

    await focusEditable(() => document.querySelector('[contenteditable="true"]'))

    expect(document.activeElement).toBe(second)
    expect(document.activeElement).not.toBe(first)
  })

  it('re-resolves per retry: an editable that appears only after the wait began', async () => {
    // The discriminating case. A swap completed BEFORE the call is caught by
    // resolving once at entry too; only a node that arrives DURING the wait
    // separates per-retry resolution from a single resolve — and that is the
    // loaded-run reality, where the contentDOM lands late.
    setTimeout(() => {
      editableDiv()
    }, 120)

    await focusEditable(() => document.querySelector('[contenteditable="true"]'))

    expect((document.activeElement as HTMLElement).isContentEditable).toBe(true)
  })

  it('fails loudly on a resolver frozen to a detached node, because focus() cannot take', async () => {
    // The OLD shape — an element held by value — reduced to its essence. The
    // browser leaves activeElement on <body> (focus on a disconnected element
    // is a spec'd no-op), so the wait can only time out. Pinned so the helper
    // is never quietly reverted to taking an element again.
    const held = editableDiv()
    held.remove()

    await expect(focusEditable(() => held)).rejects.toThrow(/expected/)
    expect(document.activeElement).toBe(document.body)
  }, 10_000)
})
