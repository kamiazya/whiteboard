/**
 * Turning a selection into a stored anchor.
 *
 * The inverse of `resolveTextAnchor`, and the reason it is tested apart from
 * any editor: what gets WRITTEN here is what a later reader has to re-find,
 * so the quote and its surroundings are the whole contract. An editor can be
 * swapped; a badly-shaped anchor is stored forever.
 */
import { describe, expect, it } from 'vitest'
import { resolveTextAnchor } from './text-anchor.js'
import { textAnchorForSelection } from './text-anchor-for-selection.js'

const BODY = 'A first line.\nThe report is due on Friday, and the draft is not written.'

describe('textAnchorForSelection', () => {
  it('quotes exactly what was selected, and remembers where it was', () => {
    const at = BODY.indexOf('due on Friday')
    const anchor = textAnchorForSelection(BODY, at, at + 'due on Friday'.length)
    expect(anchor?.quote.exact).toBe('due on Friday')
    expect(anchor?.start).toBe(at)
    expect(anchor?.end).toBe(at + 'due on Friday'.length)
  })

  it('carries the surroundings, which is what disambiguates a repeated quote', () => {
    const at = BODY.indexOf('due on Friday')
    const anchor = textAnchorForSelection(BODY, at, at + 'due on Friday'.length)
    // Not asserting a LENGTH here — that is a measured parameter, and pinning
    // it in two places is how the two drift. What matters is that each side
    // is real body text ending/starting at the passage's own edge.
    expect(anchor?.quote.prefix).not.toBe('')
    expect(BODY.slice(0, at).endsWith(anchor?.quote.prefix ?? 'x')).toBe(true)
    expect(BODY.slice(at + 'due on Friday'.length).startsWith(anchor?.quote.suffix ?? 'x')).toBe(
      true,
    )
  })

  it('omits a side that has no body text, rather than storing an empty string', () => {
    // At the very start there is nothing before the passage. An empty
    // `prefix` would claim "the passage is preceded by nothing" as evidence,
    // which scores identically for every candidate and is worse than silence.
    const anchor = textAnchorForSelection(BODY, 0, 'A first line.'.length)
    expect(anchor?.quote.prefix).toBeUndefined()
    expect(anchor?.quote.suffix).not.toBe('')
  })

  it('refuses a selection with nothing to quote', () => {
    // `textQuoteSelectorSchema` requires at least one character, and a
    // whitespace-only quote would re-anchor onto any gap in the document.
    expect(textAnchorForSelection(BODY, 5, 5)).toBeNull()
    expect(textAnchorForSelection(BODY, 13, 14)).toBeNull()
  })

  it('finds the right one of two identical passages when a side survives the edit', () => {
    // The mechanism the context length was measured on, pinned as an example.
    // The body holds the passage TWICE and is then edited above it, so the
    // stored offset is nearer the SECOND occurrence — distance alone answers
    // wrongly, and only the surviving suffix gets it right.
    const passage = 'needs a decision'
    const body = `An opening paragraph long enough to delete a chunk out of. ${passage} then a middle stretch ${passage} and a close.`
    const at = body.indexOf(passage)
    const anchor = textAnchorForSelection(body, at, at + passage.length)

    // Derived, never hand-counted: deleting MORE than half the gap is what
    // moves the stored offset past the midpoint, and a number picked by eye
    // is how the first version of this test failed to invert anything.
    const gap = body.lastIndexOf(passage) - at
    const cut = Math.floor(gap / 2) + 4
    const edited = body.slice(0, at - cut) + body.slice(at)
    const moved = edited.indexOf(passage)
    // Distance really does lie here: the stored offset is nearer the second.
    expect(Math.abs(moved - at)).toBeGreaterThan(Math.abs(edited.lastIndexOf(passage) - at))
    expect(resolveTextAnchor(edited, anchor as NonNullable<typeof anchor>)).toEqual({
      kind: 'placed',
      start: moved,
      end: moved + passage.length,
    })
  })

  it('produces an anchor that resolves back to the passage it was made from', () => {
    // The round trip is the point: what this writes, `resolveTextAnchor` has
    // to find again. A test of either half alone can pass while the pair is
    // broken.
    const at = BODY.indexOf('the draft')
    const anchor = textAnchorForSelection(BODY, at, at + 'the draft'.length)
    expect(anchor).not.toBeNull()
    expect(resolveTextAnchor(BODY, anchor as NonNullable<typeof anchor>)).toEqual({
      kind: 'placed',
      start: at,
      end: at + 'the draft'.length,
    })
  })
})
