import { describe, expect, test } from 'vitest'
import { TEXT_ANCHOR_CONTEXT_MAX_CHARS, type TextAnchor } from './annotation.js'
import { placeTextAnchor, resolveTextAnchor } from './text-anchor.js'

function anchorAt(
  body: string,
  exact: string,
  extra: Partial<TextAnchor['quote']> = {},
): TextAnchor {
  const start = body.indexOf(exact)
  return {
    kind: 'text',
    quote: { exact, ...extra },
    start,
    end: start + exact.length,
  }
}

describe('resolveTextAnchor', () => {
  test('the stored offsets hold when nothing moved', () => {
    const body = 'The plan is to ship on Thursday.'
    expect(resolveTextAnchor(body, anchorAt(body, 'Thursday'))).toEqual({
      kind: 'placed',
      start: 23,
      end: 31,
    })
  })

  test('a mark wins outright over the quote', () => {
    const body = 'The plan is to ship on Thursday.'
    expect(resolveTextAnchor(body, anchorAt(body, 'Thursday'), { start: 4, end: 8 })).toEqual({
      kind: 'placed',
      start: 4,
      end: 8,
    })
  })

  test('the only occurrence elsewhere is found after an edit above it', () => {
    const anchor = anchorAt('The plan is to ship on Thursday.', 'Thursday')
    const edited = 'Note. The plan is to ship on Thursday.'
    expect(resolveTextAnchor(edited, anchor)).toEqual({ kind: 'placed', start: 29, end: 37 })
  })

  test('context breaks a tie between several occurrences', () => {
    const body = 'ship on Thursday. We used to ship on Thursday too.'
    // Stale offsets on purpose: while `body.slice(start, end)` is still the
    // quote the resolver stops at branch 1, and the tiebreak this case exists
    // to exercise never runs.
    const anchor: TextAnchor = {
      kind: 'text',
      quote: { prefix: 'used to ship on ', exact: 'Thursday', suffix: ' too' },
      start: 0,
      end: 8,
    }
    expect(resolveTextAnchor(body, anchor)).toEqual({ kind: 'placed', start: 37, end: 45 })
  })

  test('a passage that is gone orphans rather than pointing somewhere else', () => {
    const anchor = anchorAt('The plan is to ship on Thursday.', 'Thursday')
    expect(resolveTextAnchor('The plan changed entirely.', anchor)).toEqual({ kind: 'orphaned' })
  })
})

/**
 * A string that counts how many of its characters were read. An index read
 * is one character; any method call or coercion is charged the whole string,
 * so an implementation that slices or compares wholesale is not read as free.
 */
function countingString(value: string): { readonly text: string; reads(): number } {
  let reads = 0
  const text = new Proxy(new String(value), {
    get(target, key) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1
      else if (key !== 'length') reads += value.length
      const found: unknown = Reflect.get(target, key, target)
      return typeof found === 'function' ? found.bind(target) : found
    },
  })
  return { text: text as unknown as string, reads: () => reads }
}

describe('the cost of a remembered context', () => {
  test('a long prefix on a body of repeated lines reads a bounded window per occurrence', () => {
    // A checklist of identical lines is the case where every occurrence
    // matches the context for as far back as the body goes, so an unbounded
    // comparison reads `occurrences x prefix.length` characters — measured at
    // 9.5 s for one resolution of a 245,000-character body.
    const line = '- [ ] the same item again\n'
    const body = line.repeat(400)
    const exact = 'the same item'
    const occurrences = body.split(exact).length - 1
    const last = body.lastIndexOf(exact)
    const prefix = countingString(body.slice(0, last))
    const suffix = countingString(body.slice(last + exact.length))

    const resolved = resolveTextAnchor(body, {
      kind: 'text',
      quote: { exact, prefix: prefix.text, suffix: suffix.text },
      // An empty range where the passage starts: the offsets shortcut
      // misses, so every occurrence is scored, and the many occurrences
      // whose nearest context ties are told apart by distance to here.
      start: last,
      end: last,
    })

    expect(resolved).toEqual({ kind: 'placed', start: last, end: last + exact.length })
    // The fixture really is the expensive shape: the context is far longer
    // than the window, and there are many occurrences to score.
    expect(prefix.reads() + suffix.reads()).toBeGreaterThan(0)
    expect(body.length).toBeGreaterThan(20 * TEXT_ANCHOR_CONTEXT_MAX_CHARS)
    expect(occurrences).toBe(400)
    const budget = occurrences * 2 * (TEXT_ANCHOR_CONTEXT_MAX_CHARS + 1)
    expect(prefix.reads() + suffix.reads()).toBeLessThanOrEqual(budget)
  })
})

describe('the cost of a long quote', () => {
  test('a long quote on a periodic body reads it a bounded number of times', () => {
    // Every position of a one-character body starts an occurrence of a run
    // of that character, so a search that re-verifies the whole quote at
    // each overlapping occurrence reads `occurrences x exact.length`
    // characters — measured at 9.7 s for a 64 Ki quote on a 256 Ki body.
    const body = 'a'.repeat(8192)
    const exact = countingString('a'.repeat(2048))
    const occurrences = body.length - 2048 + 1

    const resolved = resolveTextAnchor(body, {
      kind: 'text',
      quote: { exact: exact.text },
      start: 4000,
      end: 4000,
    })

    expect(resolved).toEqual({ kind: 'placed', start: 4000, end: 4000 + 2048 })
    expect(occurrences).toBeGreaterThan(1000)
    expect(exact.reads()).toBeGreaterThan(0)
    expect(exact.reads()).toBeLessThanOrEqual(4 * (body.length + 2048))
  })
})

describe('placeTextAnchor', () => {
  const anchor = (start: number, end: number): TextAnchor => ({
    kind: 'text',
    quote: { exact: 'echo' },
    start,
    end,
  })

  test('re-states miscounted offsets at where the quote is', () => {
    expect(placeTextAnchor('say echo once', anchor(0, 4))).toEqual(anchor(4, 8))
  })

  test('keeps offsets that already select one of several occurrences', () => {
    const second = anchor(10, 14)
    expect(placeTextAnchor('echo one, echo two', second)).toBe(second)
  })

  test('answers nothing for a passage the text does not hold', () => {
    expect(placeTextAnchor('no such words', anchor(0, 4))).toBeUndefined()
  })
})
