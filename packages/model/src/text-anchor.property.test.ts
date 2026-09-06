/**
 * The invariant that makes re-anchoring worth doing at all: a resolved anchor
 * points at ITS OWN quote, or says it has lost its place. Never at other
 * words.
 *
 * A property rather than examples because the interesting inputs are edits,
 * and the space of "where the edit landed relative to the passage" is exactly
 * what a hand-written case set gets thin at — before it, inside it, after it,
 * spanning its edge, and duplicating it.
 *
 * The generator builds a body out of NAMED pieces and then edits it, so every
 * case knows where the passage is without the test having to search for it —
 * which would be building the oracle out of the code under test.
 */
import { describe, expect, it } from 'vitest'
import type { TextAnchor } from './annotation.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'
import { resolveTextAnchor } from './text-anchor.js'

/** Ordinary prose, and never the passage's own text — see `passage`. */
const filler = fc.stringMatching(/^[a-d ]{0,40}$/)
/**
 * The quoted passage. Drawn from a disjoint alphabet so a generated body
 * cannot contain it by accident: an accidental second occurrence would make
 * "the quote appears once" false and the case would be testing something
 * other than what it says.
 */
const passage = fc.stringMatching(/^[x-z]{1,12}$/)

interface Built {
  readonly body: string
  readonly anchor: TextAnchor
  readonly quote: string
}

/** A body with the passage in it, and the anchor that was stored for it. */
const built: fc.Arbitrary<Built> = fc
  .tuple(filler, passage, filler)
  .map(([before, quote, after]) => {
    const body = `${before}${quote}${after}`
    const start = before.length
    return {
      body,
      quote,
      anchor: {
        kind: 'text' as const,
        quote: {
          exact: quote,
          ...(before === '' ? {} : { prefix: before.slice(-8) }),
          ...(after === '' ? {} : { suffix: after.slice(0, 8) }),
        },
        start,
        end: start + quote.length,
      },
    }
  })

describe('resolveTextAnchor', () => {
  fcTest.prop([built], withDefaults())(
    'finds the passage in the body it was stored against',
    (b) => {
      const resolved = resolveTextAnchor(b.body, b.anchor)

      expect(resolved.kind).toBe('placed')
      if (resolved.kind !== 'placed') return
      expect(b.body.slice(resolved.start, resolved.end)).toBe(b.quote)
    },
  )

  fcTest.prop([built, filler], withDefaults())(
    'follows the passage when text is inserted above it',
    (b, inserted) => {
      // The case offsets alone cannot survive, and the reason the quote is
      // stored at all: everything below an edit moves by its length.
      const edited = inserted + b.body
      const resolved = resolveTextAnchor(edited, b.anchor)

      expect(resolved.kind).toBe('placed')
      if (resolved.kind !== 'placed') return
      // The claim is about the TEXT, not the arithmetic: asserting
      // `start + inserted.length` would just re-implement the shift and pass
      // against a resolver that had shifted the wrong passage.
      expect(edited.slice(resolved.start, resolved.end)).toBe(b.quote)
    },
  )

  fcTest.prop([built], withDefaults())('says a passage that was deleted is orphaned', (b) => {
    // The alphabets are disjoint, so removing the passage removes every
    // occurrence of it — this is a real deletion, not a move.
    const edited = b.body.replace(b.quote, '')

    expect(resolveTextAnchor(edited, b.anchor)).toEqual({ kind: 'orphaned' })
  })

  fcTest.prop([built, filler], withDefaults())(
    're-resolving from the offsets it just answered is a no-op',
    (b, inserted) => {
      // What the caller does with the answer: write it back and read again.
      // Without this the resolver could be right once and drift on every
      // subsequent read, which is the shape a reader would experience as a
      // comment slowly walking down the document.
      const edited = inserted + b.body
      const first = resolveTextAnchor(edited, b.anchor)
      if (first.kind !== 'placed') return

      const again = resolveTextAnchor(edited, {
        ...b.anchor,
        start: first.start,
        end: first.end,
      })
      expect(again).toEqual(first)
    },
  )
})

describe('choosing between several copies of the same passage', () => {
  it('keeps the one the offsets point at, rather than the first', () => {
    // Two identical sentences: the offsets are the ONLY thing that says which
    // one the thread was about, and a search that ignored them would move
    // every such comment to the top of the document.
    const body = 'note it. note it. note it.'
    const anchor: TextAnchor = {
      kind: 'text',
      quote: { exact: 'note it.' },
      start: 18,
      end: 26,
    }

    expect(resolveTextAnchor(body, anchor)).toEqual({ kind: 'placed', start: 18, end: 26 })
  })

  it('uses the remembered surroundings when the offsets no longer land on it', () => {
    // The offsets have gone stale (text was inserted above), so the fast path
    // misses and three candidates remain. `suffix` is what distinguishes them.
    const body = 'PREAMBLE. ship it. later ship it. finally ship it.'
    const anchor: TextAnchor = {
      kind: 'text',
      quote: { exact: 'ship it.', prefix: 'finally ', suffix: '' },
      start: 0,
      end: 8,
    }

    // Derived, not hand-counted: the claim is WHICH occurrence, and a typed
    // offset only adds a second thing to get wrong. The first version of this
    // line said 41 and the resolver was right.
    const expected = body.lastIndexOf('ship it.')
    expect(resolveTextAnchor(body, anchor)).toEqual({
      kind: 'placed',
      start: expected,
      end: expected + 'ship it.'.length,
    })
  })
})
