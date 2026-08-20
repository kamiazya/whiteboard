// Every failure mode this helper has actually produced in CI, made
// deterministic. The symptom was always the same — `expected <body> … to be
// <div …>` — while the causes were four different things; each is pinned
// under conditions that force it, so none can be quietly reintroduced.

import { afterEach, describe, expect, it } from 'vitest'
import { focusEditable } from './focus-editable.js'

afterEach(() => {
  document.body.replaceChildren()
})

function editable(): HTMLElement {
  const el = document.createElement('div')
  el.contentEditable = 'true'
  document.body.appendChild(el)
  return el
}

describe('focusEditable', () => {
  it('focuses what the resolver answers', async () => {
    const el = editable()

    await focusEditable(() => el)

    expect(document.activeElement).toBe(el)
  })

  it('re-resolves per retry: an editable that appears only after the wait began', async () => {
    // The discriminating case for the resolver signature. A swap completed
    // BEFORE the call is satisfied by resolving once at entry too; only a node
    // that arrives DURING the wait separates per-retry resolution from a
    // single resolve — and that is the loaded-run reality, where the
    // contentDOM lands late. The first version of this suite swapped before
    // calling, and the resolve-once mutation stayed green against it.
    setTimeout(() => {
      editable()
    }, 120)

    await focusEditable(() => document.querySelector('[contenteditable="true"]'))

    expect((document.activeElement as HTMLElement).isContentEditable).toBe(true)
  })

  it('names the frozen-resolver case instead of timing out on a dead node', async () => {
    // A reference held across a re-render, the repo's sixth flake shape. A
    // detached node cannot take focus and never will, so waiting is the one
    // thing that cannot help — say so rather than spend the budget.
    const el = editable()
    el.remove()

    await expect(focusEditable(() => el)).rejects.toThrow(/no longer in the document/i)
  })

  it('names the unrendered case — display:none is how Read mode hides the pane', async () => {
    const el = editable()
    el.style.display = 'none'

    await expect(focusEditable(() => el)).rejects.toThrow(/not rendered/i)
  })

  it('recovers when something else takes focus first', async () => {
    // Focus is retried on every attempt rather than called once before the
    // wait: a neighbour's leftover keystrokes can steal it after the call and
    // before it settles, and waiting alone never gets it back.
    const el = editable()
    const thief = editable()
    // Steals on `focusin`, so the theft is guaranteed to land exactly when
    // focus arrives rather than racing a timer the retry can outrun.
    let steals = 0
    const steal = () => {
      if (steals < 2) {
        steals += 1
        thief.focus()
      }
    }
    el.addEventListener('focusin', steal)
    try {
      await focusEditable(() => el)
    } finally {
      el.removeEventListener('focusin', steal)
    }
    expect(steals).toBe(2)
    expect(document.activeElement).toBe(el)
  })
})
