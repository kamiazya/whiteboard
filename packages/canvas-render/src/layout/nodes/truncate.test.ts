import { afterAll, describe, expect, it } from 'vitest'
import type { FontDescriptor, MeasureText } from '../../measure.js'
import { createFakeMeasure } from '../../test-utils/fake-measure.js'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { fitToWidth } from './truncate.js'

/**
 * `fitToWidth` had no test of its own: every case reaching it came through a
 * caller pinning a RENDERED SCENE, which is why its three documented
 * clauses — no usable width returns the text, text that fits is left alone,
 * and a non-empty input never comes back empty — could each be deleted with
 * the whole suite still green. Mutation testing is what said so, and the
 * survivors landed exactly on those three lines.
 *
 * One UTF-16 unit per 10px, so every boundary below is arithmetic a reader
 * can check: `'ab'` is 20px wide, and an astral code point is 20px because
 * it is two units.
 */
const measure = createFakeMeasure(1)
const font: FontDescriptor = {
  family: 'Test',
  fallbackChain: [],
  weight: 400,
  style: 'normal',
  sizePx: 10,
}
const fit = (text: string, maxWidth: number) => fitToWidth(text, font, measure, maxWidth)

describe('fitToWidth: a width it cannot fit against', () => {
  // The documented fallback — "no width to fit against" returns the text
  // unchanged, matching how layout treats an unusable wrap width elsewhere.
  // Each case below is a mutant that survived: `||` -> `&&`, the condition
  // -> `false`, and `<= 0` -> `< 0`.
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['zero', 0],
    ['negative', -20],
  ])('returns the text untouched and unmarked for %s', (_label, maxWidth) => {
    expect(fit('abcdef', maxWidth)).toEqual({ text: 'abcdef' })
  })
})

describe('fitToWidth: text that already fits', () => {
  it('is returned unchanged, with no truncation flag', () => {
    expect(fit('ab', 100)).toEqual({ text: 'ab' })
  })

  it('answers from a single measurement instead of walking the text', () => {
    // After the truncated/overflows split the `<=` boundary is no longer
    // visible in the RESULT: at `<`, text exactly as wide as its box falls
    // through to the loop, which keeps every code point and reports neither
    // flag — the same object. What the early return buys is one measure call
    // rather than one per code point, and that is now the only thing the
    // branch does, so it is the only thing worth asserting about it.
    let calls = 0
    const counting: MeasureText = (text, f) => {
      calls += 1
      return measure(text, f)
    }

    expect(fitToWidth('ab', font, counting, 20)).toEqual({ text: 'ab' })
    expect(calls).toBe(1)
  })

  it('counts text exactly as wide as the box as fitting', () => {
    expect(fit('ab', 20)).toEqual({ text: 'ab' })
  })
})

describe('fitToWidth: text that overflows', () => {
  it('keeps the longest prefix that fits and says it cut', () => {
    expect(fit('abcdef', 25)).toEqual({ text: 'ab', truncated: true })
  })

  it('keeps a prefix that ends exactly on the boundary', () => {
    // The loop's own boundary, `candidate > maxWidth` breaks: at `>=` the
    // prefix that measures exactly `maxWidth` is dropped for no reason.
    expect(fit('abcdef', 20)).toEqual({ text: 'ab', truncated: true })
  })
})

describe('fitToWidth: never empty', () => {
  it('keeps one code point even when that code point alone overflows', () => {
    // The clause the docstring gives a reason for — "one glyph over the edge
    // still says a label is there, and nothing at all does not" — and the
    // one nothing checked: deleting the fallback left every test green.
    expect(fit('abc', 5)).toEqual({ text: 'a', truncated: true, overflows: true })
  })

  it('keeps a whole astral code point rather than half a surrogate pair', () => {
    // `[...text][0]`, not `text[0]`: the latter returns a lone high surrogate,
    // which is not a character and is not valid XML content either.
    const emoji = String.fromCodePoint(0x1f600)
    expect(fit(`${emoji}x`, 5).text).toBe(emoji)
  })

  it('still answers for the empty string', () => {
    expect(fit('', 20)).toEqual({ text: '' })
  })

  it('reports a kept-but-overflowing single code point as overflowing, not truncated', () => {
    // Found by the property below, shrunk to `(' ', 1)`: the one code point
    // does not fit, the never-empty rule keeps it anyway, and NOTHING was
    // dropped. It used to answer `truncated: true`, which two readers then
    // disagreed about in their own docstrings — `sceneDigest.truncated` says
    // "the document holds more than the canvas shows" (false here) while
    // `wb_canvas_snapshot`'s `overflows` says "the content does not fit its
    // box" (true here). One flag cannot be both, so they are two.
    expect(fit(' ', 1)).toEqual({ text: ' ', overflows: true })
  })

  it('reports both when the first code point overflows AND more follows', () => {
    // 20px for one astral code point against a 5px box: the emoji is kept
    // because nothing narrower exists, and the `x` after it is genuinely
    // dropped. Both facts are true and neither implies the other.
    const emoji = String.fromCodePoint(0x1f600)
    expect(fit(`${emoji}x`, 5)).toEqual({ text: emoji, truncated: true, overflows: true })
  })
})

describe('fitToWidth: a measurer that misreports the empty string', () => {
  it('still answers with a string rather than undefined', () => {
    // Unreachable with a CONFORMING measurer — an empty string measures
    // zero, which fits any positive `maxWidth`, so the early return above
    // takes it, and Stryker reports the `?? ''` as uncovered rather than as
    // a survivor. It is not dead code: `measure.ts` states outright that a
    // measurer can violate its contract and that layout clamps instead of
    // trusting it, and this is the line that keeps `FittedText.text`'s
    // promise of a `string` under that. Without it this path hands
    // `{ text: undefined }` to every caller that spreads it onto a scene
    // node, where it becomes an SVG attribute reading `undefined`.
    const liar: MeasureText = (_text, f) => ({
      advanceWidth: 999,
      ascent: f.sizePx,
      descent: 0,
      lineGap: 0,
    })
    expect(fitToWidth('', font, liar, 20)).toEqual({ text: '', overflows: true })
  })
})

describe('fitToWidth properties', () => {
  // Both axes are biased SMALL on purpose. Everything interesting here is at
  // the boundary — a text of one code point, and a width under the 10px a
  // single glyph advances — and drawn uniformly from 1..130 such a width is
  // ~7% of draws. Measured: with the uniform pair, the four-way ledger below
  // missed `false/true` in roughly one run in seven, which is a flaky test
  // that reads as a real regression. Denser generator, not more runs.
  const textArb = fc.oneof(
    fc.string({ minLength: 1, maxLength: 2 }),
    fc.string({ minLength: 1, maxLength: 12 }),
  )
  const widthArb = fc.oneof(fc.integer({ min: 1, max: 9 }), fc.integer({ min: 1, max: 130 }))

  // `truncated`/`overflows` as the generator actually reached them. Guarded
  // from both sides: a combination the domain never produces fails as an
  // unreached entry, and a combination not declared here fails as an excess
  // one — so the pair cannot quietly collapse back into a single flag.
  const COMBINATIONS = {
    'false/false': 'the whole text fits, or there was no usable width',
    'true/false': 'a prefix was cut, and that prefix fits',
    'false/true': 'the whole input is one code point too wide to cut',
    'true/true': 'the first code point is too wide AND more followed it',
  } as const
  const seenCombinations = new Map<string, number>()
  // A floor, not merely presence: one lucky draw in 200 would satisfy a
  // presence check while proving almost nothing, and is the state the uniform
  // generator above was in. Measured over 200 runs with this generator —
  // false/false 60, false/true 33, true/false 24, true/true 83 — so the floor
  // sits well under the scarcest without pinning a distribution that a
  // fast-check version bump is free to shift.
  const COMBINATION_FLOOR = 5
  afterAll(() => {
    expect([...seenCombinations.keys()].sort()).toEqual(Object.keys(COMBINATIONS).sort())
    for (const [combination, count] of seenCombinations) {
      expect({ combination, atLeast: count >= COMBINATION_FLOOR }).toEqual({
        combination,
        atLeast: true,
      })
    }
  })

  fcTest.prop([textArb, widthArb], withDefaults())(
    'the result is always a prefix of the input',
    (text, maxWidth) => {
      expect(text.startsWith(fit(text, maxWidth).text)).toBe(true)
    },
  )

  fcTest.prop([textArb, widthArb], withDefaults())(
    'a non-empty input never comes back empty',
    (text, maxWidth) => {
      expect(fit(text, maxWidth).text).not.toBe('')
    },
  )

  fcTest.prop([textArb, widthArb], withDefaults())(
    'it fits, or it is the one code point that could not',
    (text, maxWidth) => {
      const { text: result } = fit(text, maxWidth)
      const width = measure(result, font).advanceWidth
      expect(width <= maxWidth || [...result].length === 1).toBe(true)
    },
  )

  fcTest.prop([textArb, widthArb], withDefaults())(
    '`truncated` says exactly whether anything was dropped',
    (text, maxWidth) => {
      // BOTH directions, which is what the split bought: the flag is now
      // equivalent to "the result is a strict prefix", with no case where one
      // holds and the other does not.
      const fitted = fit(text, maxWidth)
      expect(fitted.truncated === true).toBe(fitted.text !== text)
    },
  )

  fcTest.prop([textArb, widthArb], withDefaults())(
    '`overflows` says exactly whether what is returned still does not fit',
    (text, maxWidth) => {
      const fitted = fit(text, maxWidth)
      const spills = measure(fitted.text, font).advanceWidth > maxWidth
      expect(fitted.overflows === true).toBe(spills)
    },
  )

  fcTest.prop([textArb, widthArb], withDefaults())(
    'the two flags are independent — every combination the domain allows occurs',
    (text, maxWidth) => {
      // A guard against the split collapsing back into one flag by accident:
      // if `overflows` were only ever set alongside `truncated`, the property
      // above would still pass and nothing would have been gained. The
      // afterAll below is what actually checks the domain reaches all four.
      const { truncated, overflows } = fit(text, maxWidth)
      const combination = `${truncated === true}/${overflows === true}`
      seenCombinations.set(combination, (seenCombinations.get(combination) ?? 0) + 1)
    },
  )

  fcTest.prop([textArb, widthArb, widthArb], withDefaults())(
    'more room never returns less text',
    (text, a, b) => {
      const [narrow, wide] = a <= b ? [a, b] : [b, a]
      expect(fit(text, wide).text.length).toBeGreaterThanOrEqual(fit(text, narrow).text.length)
    },
  )
})

/**
 * A label is cut on GRAPHEME boundaries, not code points.
 *
 * `[...text]` walked code points, so a cut landed inside a cluster and drew a
 * fragment: measured over the swept widths of a label carrying six of each
 * class, a ZWJ family fragmented at 36 widths (a lone 👨), a Devanagari
 * cluster at 18, a keycap at 12, and a flag and a skin-tone modifier at 6
 * each.
 */
describe('fitToWidth: cuts between characters a reader sees as one', () => {
  const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  const split = (value: string): string[] => [...GRAPHEMES.segment(value)].map((g) => g.segment)

  const CLASSES = {
    'ZWJ family': '👨‍👩‍👧‍👦',
    flag: '🇯🇵',
    'skin-tone modifier': '👍🏽',
    keycap: '1️⃣',
    // DECOMPOSED on purpose: the precomposed form is one code point, so the
    // code-point walk already kept it whole and the case proved nothing.
    'combining accent': 'e\u0301',
    devanagari: 'क्षि',
    'halfwidth dakuten': 'ｶﾞ',
  } as const

  /**
   * Widths whose cut fell immediately after a cluster of more than one code
   * point — the arrangement in which the old rule COULD have stopped halfway
   * through one and drawn a fragment.
   *
   * Counting the fragments themselves was the obvious thing and is useless:
   * that number is zero once the fix is in, by construction, so it can never
   * tell a sweep that reached the interesting widths from one that reached
   * none. This counts the OPPORTUNITY, which survives the fix.
   */
  let cutAfterACluster = 0

  afterAll(() => {
    expect(
      cutAfterACluster,
      'no swept width cut next to a multi-code-point cluster — the sweep never reached the case',
    ).toBeGreaterThan(20)
  })

  for (const [name, cluster] of Object.entries(CLASSES)) {
    it(`keeps ${name} whole at every width`, () => {
      const label = `Task ${cluster.repeat(6)} done`
      const whole = new Set(split(label))
      for (let width = 10; width <= label.length * 10; width += 10) {
        const kept = fit(label, width).text
        const units = split(kept)
        const last = units[units.length - 1]
        if (last !== undefined && [...last].length > 1) cutAfterACluster += 1
        expect(units.filter((unit) => !whole.has(unit) && unit.trim() !== '')).toEqual([])
      }
    })
  }

  /**
   * The gate that keeps the common label on the cheap path, checked against
   * the segmenter over BOTH axes, because a code point that joins and is not
   * caught here is a label that fragments with nothing red.
   *
   * The single axis this replaced swept every candidate joiner against nine
   * hand-picked predecessors, and read as exhaustive while being exhaustive
   * only in one direction: `\r` was not among the nine, so LF-after-CR — the
   * one sub-U+0300 join there is — went unseen and the gate shipped claiming
   * an absolute that was false.
   *
   * Every predecessor below U+0300 is swept in one segmentation per
   * candidate: `a0 j a1 j ...` holds one segment per character unless
   * something joined, since a join only ever LOWERS the count. That admits a
   * false positive when the candidate joins the character AFTER it rather
   * than before (which is how `\r` shows up here), so each suspect is then
   * re-tested pairwise for the direction that actually matters. Complete in
   * ~600ms, against 2.2s for 768x768 pairwise.
   */
  it('nothing below U+0300 joins the character before it, except LF after CR', () => {
    const predecessors = [
      ...Array.from({ length: 0x300 }, (_, cp) => String.fromCodePoint(cp)),
      'ᄀ',
      '🇯',
      '😀',
      'ｶ',
      'क',
      '가',
      'ก',
    ]
    const suspects: number[] = []
    for (let cp = 0; cp < 0x300; cp += 1) {
      const char = String.fromCodePoint(cp)
      const probe = predecessors.map((before) => before + char).join('')
      if (split(probe).length !== predecessors.length * 2) suspects.push(cp)
    }
    const joins: string[] = []
    for (const cp of suspects) {
      const char = String.fromCodePoint(cp)
      for (const before of predecessors) {
        if (split(before + char).length === 1) {
          joins.push(
            `U+${before.codePointAt(0)?.toString(16).toUpperCase()} + U+${cp.toString(16).toUpperCase()}`,
          )
        }
      }
    }
    expect(joins).toEqual(['U+D + U+A'])
  })

  it('does not cut CRLF in half', () => {
    // The one join below U+0300. Both halves are non-printing, so a cut
    // between them draws the same picture either way — what it breaks is the
    // gate's claim to be absolute, and a claim with a silent exception is one
    // nobody can rely on for the next character somebody adds.
    expect(fit('a\r\nb', 25).text).toBe('a')
  })

  it('treats U+0300 itself as a joiner', () => {
    // The gate's boundary. At `>` rather than `>=` a combining grave takes
    // the cheap path and the accent is cut off its letter.
    expect(fit('e\u0300', 15).text).toBe('e\u0300')
  })

  it('keeps a whole cluster when even one does not fit', () => {
    // The never-empty rule at grapheme granularity: `👨` alone is not a
    // smaller version of the family, it is a different picture.
    expect(fit('👨‍👩‍👧‍👦x', 5).text).toBe('👨‍👩‍👧‍👦')
  })

  it('keeps it whole when NOTHING in the text is below U+0300', () => {
    // The same rule with the ASCII taken away, and that is the whole test.
    // Every other cluster case in this file sits beside plain text — an `x`,
    // a `Task … done` label — and one character below U+0300 is enough on
    // its own to send the string down the segmenter path. So none of them
    // can see whether the GATE agrees about which strings may hold a
    // cluster; they pass with it inverted. A text made only of characters at
    // or above U+0300 is the one shape that asks it, and the answer under an
    // inverted gate is a lone `👨`.
    expect(fit('👨‍👩‍👧‍👦', 5).text).toBe('👨‍👩‍👧‍👦')
  })
})
