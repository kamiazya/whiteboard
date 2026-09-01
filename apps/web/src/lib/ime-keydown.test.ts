import { describe, expect, it } from 'vitest'
import { isImeComposingKeydown } from './ime-keydown.js'

// A single-line input that commits on Enter must ignore the Enter that
// CONFIRMS an IME composition — for a Japanese typist that key means "accept
// this conversion", not "I am done with the field". Two spellings reach us:
// `isComposing` (the spec'd flag, set in Chrome/Firefox), and the legacy
// `keyCode === 229` WebKit emits for keydowns fired while an IME is active.
describe('isImeComposingKeydown', () => {
  it('is true while the spec flag says a composition is active', () => {
    expect(isImeComposingKeydown({ isComposing: true, keyCode: 13 })).toBe(true)
  })

  it('is true for the WebKit 229 keydown even when the flag is unset', () => {
    expect(isImeComposingKeydown({ isComposing: false, keyCode: 229 })).toBe(true)
  })

  it('is false for a plain keydown outside composition', () => {
    expect(isImeComposingKeydown({ isComposing: false, keyCode: 13 })).toBe(false)
  })
})
