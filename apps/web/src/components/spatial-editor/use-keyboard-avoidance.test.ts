// @vitest-environment node
// The occlusion arithmetic behind keyboard avoidance: client rects are
// layout-viewport coordinates and the visual viewport's offsetTop + height
// is its bottom edge in the same space, so the covered strip is whatever of
// the root extends past that edge.
import { describe, expect, it } from 'vitest'
import { keyboardOccludedBottomPx } from './use-keyboard-avoidance.js'

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
