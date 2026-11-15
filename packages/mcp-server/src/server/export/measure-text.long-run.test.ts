/**
 * A long run of text costs the measurer time in proportion to its length.
 *
 * opentype.js's `getAdvanceWidth` is quadratic in the string it is handed: its
 * ccmp pass slices the whole context once per glyph, and layout hands the
 * measurer a whole paragraph, so one long paragraph in a text node once held
 * the daemon for tens of seconds. The measurer sums each code point's own
 * advance instead and never asks opentype to shape, so it is additive over any
 * cut — which is what the property below holds it to, over runs dense in the
 * marks the face's GSUB would have composed.
 */
import { readFile } from 'node:fs/promises'
import type { FontDescriptor } from '@kamiazya/whiteboard-canvas-render'
import { NODE_TEXT_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import type * as opentype from 'opentype.js'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { opentypeApi } from '../../shared/opentype.js'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'
import { resolveExportFontFaces } from './export-font.js'
import { _resetExportMeasureTextCacheForTests } from './measure-text.js'
import { opentypeMeasureText } from './test-utils/opentype-measure.js'

const descriptor = (sizePx: number): FontDescriptor => ({
  family: 'Roboto',
  fallbackChain: [],
  weight: 400,
  style: 'normal',
  sizePx,
})

/** Prose with no paragraph break: the shape one long line of output takes. */
function paragraphOfLength(length: number): string {
  return 'Lorem ipsum dolor sit amet. '.repeat(Math.ceil(length / 28)).slice(0, length)
}

afterAll(() => _resetExportMeasureTextCacheForTests())

describe('a paragraph far longer than a line', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each([
    ['prose with no paragraph break', paragraphOfLength(4096)],
    ['one base under marks up to a node text', `a${'\u0301'.repeat(NODE_TEXT_MAX_CHARS - 1)}`],
  ])('measures %s without asking opentype to shape it', async (_, text) => {
    const measure = await opentypeMeasureText()
    const spy = vi.spyOn(opentypeApi.Font.prototype, 'getAdvanceWidth')

    const { advanceWidth } = measure(text, descriptor(16))

    // Present before absent: a measurer answering nothing would also call nothing.
    expect(advanceWidth).toBeGreaterThan(0)
    expect(spy).not.toHaveBeenCalled()
  })
})

/**
 * Code points the face's GSUB substitutes together with what precedes them:
 * the combining marks its ccmp composes onto `i`, `j` and `l` (dropping the
 * dot, 0.07-1.7px at 16px against the plain sum) and a joiner. Written as
 * numbers because each is invisible in source.
 */
const JOINING = [0x300, 0x301, 0x302, 0x307, 0x308, 0x323, 0x327, 0x200d].map((cp) =>
  String.fromCodePoint(cp),
)
const DOTTED = ['i', 'j', 'l', String.fromCodePoint(0x12f)]
const PLAIN = [...'abcdefghmnoxyzIJ0123456789 .,-?']

/**
 * Dense in those code points, so a cut lands beside one in most runs and
 * shaping would move most runs' width — the floor below is what proves that,
 * rather than the density being assumed.
 */
const runArbitrary = fc
  .array(
    fc.oneof(
      { weight: 4, arbitrary: fc.constantFrom(...JOINING) },
      { weight: 4, arbitrary: fc.constantFrom(...DOTTED) },
      { weight: 1, arbitrary: fc.constantFrom(...PLAIN) },
    ),
    { minLength: 130, maxLength: 400 },
  )
  .map((chars) => chars.join(''))

const NUM_RUNS = 60

describe('cutting a run anywhere', () => {
  let font: opentype.Font
  let shapingDiffered = 0

  beforeAll(async () => {
    const path = (await resolveExportFontFaces()).regular
    if (path === null) throw new Error('the vendored Regular face did not resolve')
    font = opentypeApi.parse((await readFile(path)).buffer)
    // A code point the face lacks never reaches the face's advances as part of a run.
    for (const char of [...JOINING, ...DOTTED, ...PLAIN]) {
      expect(font.charToGlyphIndex(char), char.codePointAt(0)?.toString(16)).not.toBe(0)
    }
  })

  afterAllFloor(['measures the run as the sum of its two pieces'], () => {
    // Reachability: opentype's shaping must measure a good share of these runs
    // otherwise, or the property holds over text no substitution reaches and
    // says nothing about marks. It differs in nearly every run of this density.
    expect(shapingDiffered).toBeGreaterThan(NUM_RUNS / 2)
  })

  fcTest.prop(
    [runArbitrary, fc.nat(), fc.constantFrom(11, 13.5, 16, 21)],
    withDefaults({ numRuns: NUM_RUNS }),
  )('measures the run as the sum of its two pieces', async (text, at, sizePx) => {
    const measure = await opentypeMeasureText()
    const advance = (run: string) => measure(run, descriptor(sizePx)).advanceWidth
    const codePoints = Array.from(text)
    const cut = at % (codePoints.length + 1)
    const whole = advance(text)
    if (Math.abs(font.getAdvanceWidth(text, sizePx, { kerning: false }) - whole) > 1e-9) {
      shapingDiffered++
    }

    const pieces =
      advance(codePoints.slice(0, cut).join('')) + advance(codePoints.slice(cut).join(''))
    expect(whole).toBeCloseTo(pieces, 9)
  })
})
