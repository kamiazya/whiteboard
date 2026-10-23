import { afterEach, describe, expect, it } from 'vitest'
import { mayAutofocus, noteFocusPlaced, resetFocusClaim } from './focus-claim.js'

afterEach(resetFocusClaim)

describe('mayAutofocus', () => {
  it('allows a claim when nothing the user placed focus on is recent', () => {
    expect(mayAutofocus(1_000)).toBe(true)
  })

  it('refuses a claim shortly after the user placed focus in a field', () => {
    noteFocusPlaced(1_000)
    expect(mayAutofocus(2_500)).toBe(false)
  })

  it('allows a claim again once the placement is long past', () => {
    noteFocusPlaced(1_000)
    expect(mayAutofocus(1_000 + 60_000)).toBe(true)
  })
})
