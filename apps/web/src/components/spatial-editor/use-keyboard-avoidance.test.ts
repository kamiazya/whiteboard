// The occlusion arithmetic behind keyboard avoidance: client rects are
// layout-viewport coordinates and the visual viewport's offsetTop + height
// is its bottom edge in the same space, so the covered strip is whatever of
// the root extends past that edge.
import { describe, expect, it } from 'vitest'
import { keyboardAvoidanceSubject, keyboardOccludedBottomPx } from './use-keyboard-avoidance.js'

describe('keyboardOccludedBottomPx', () => {
  it('reports the strip of the root under the keyboard', () => {
    // Root bottom at 600, keyboard shrinks the visual viewport to 350.
    expect(keyboardOccludedBottomPx(600, { height: 350, offsetTop: 0 })).toBe(250)
  })

  it('is zero when the visual viewport still reaches past the root', () => {
    expect(keyboardOccludedBottomPx(600, { height: 800, offsetTop: 0 })).toBe(0)
    expect(keyboardOccludedBottomPx(600, { height: 600, offsetTop: 0 })).toBe(0)
  })

  it('follows offsetTop when iOS pans the visual viewport instead of resizing it', () => {
    // Same 350px-tall visual viewport, scrolled down 100px: its bottom edge
    // moves to 450, uncovering 100px more of the root.
    expect(keyboardOccludedBottomPx(600, { height: 350, offsetTop: 100 })).toBe(150)
  })
})

describe('keyboardAvoidanceSubject', () => {
  function mount(html: string): HTMLElement {
    const root = document.createElement('div')
    root.innerHTML = html
    document.body.appendChild(root)
    return root
  }

  it('is the overlay that owns the focused text entry', () => {
    const root = mount('<div role="dialog" data-editor-overlay><textarea></textarea></div>')
    root.querySelector('textarea')?.focus()
    expect(keyboardAvoidanceSubject(root)).toBe(root.querySelector('[data-editor-overlay]'))
  })

  it('is the entry itself when no overlay owns it', () => {
    const root = mount('<textarea></textarea>')
    root.querySelector('textarea')?.focus()
    expect(keyboardAvoidanceSubject(root)).toBe(root.querySelector('textarea'))
  })

  it('is nothing for a control that raises no keyboard, or focus outside the root', () => {
    const root = mount('<div data-editor-overlay><button>x</button></div>')
    root.querySelector('button')?.focus()
    expect(keyboardAvoidanceSubject(root)).toBeNull()
    const outside = mount('<textarea></textarea>')
    outside.querySelector('textarea')?.focus()
    expect(keyboardAvoidanceSubject(root)).toBeNull()
  })
})
