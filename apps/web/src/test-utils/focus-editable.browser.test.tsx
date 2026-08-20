// `focusEditable` is what eleven browser tests depend on to receive a
// keystroke at all, so when it fails it has to say WHY. It failed across a
// whole file in CI with `expected <body>… to be <div spellcheck=…>`, which
// names the symptom and none of the three things that produce it.
import { afterEach, describe, expect, it } from 'vitest'
import { focusEditable } from './focus-editable.js'

afterEach(() => {
  for (const el of document.querySelectorAll('[data-focus-fixture]')) el.remove()
})

function editable(): HTMLElement {
  const el = document.createElement('div')
  el.contentEditable = 'true'
  el.setAttribute('data-focus-fixture', '')
  document.body.append(el)
  return el
}

describe('focusEditable', () => {
  it('focuses a live editable', async () => {
    const el = editable()
    await focusEditable(el)
    expect(document.activeElement).toBe(el)
  })

  it('names the detached case instead of timing out on a dead node', async () => {
    // The shape this repo has now hit three times: a reference held across a
    // re-render. A detached node cannot take focus and never will, so waiting
    // is the one thing that cannot help — say so rather than spend the budget.
    const el = editable()
    el.remove()
    await expect(focusEditable(el)).rejects.toThrow(/no longer in the document/i)
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
      await focusEditable(el)
    } finally {
      el.removeEventListener('focusin', steal)
    }
    expect(steals).toBe(2)
    expect(document.activeElement).toBe(el)
  })
})
