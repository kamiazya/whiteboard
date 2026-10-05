/**
 * A long run of text costs the measurer time in proportion to its length.
 *
 * opentype.js's `getAdvanceWidth` is quadratic in the string it is handed: its
 * ccmp pass slices the whole context once per glyph. Text layout hands the
 * measurer a whole paragraph, so one long paragraph in a text node held the
 * daemon for tens of seconds. The measurer therefore hands opentype bounded
 * segments and sums them — which is only correct while no substitution spans
 * a cut, and that is what the property below holds it to, against the font
 * measuring the whole string in one call.
 */
import { readFile } from 'node:fs/promises'
import type { FontDescriptor } from '@kamiazya/whiteboard-canvas-render'
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

  it('reaches opentype only as bounded segments', async () => {
    const measure = await opentypeMeasureText()
    const spy = vi.spyOn(opentypeApi.Font.prototype, 'getAdvanceWidth')

    measure(paragraphOfLength(4096), descriptor(16))

    const lengths = spy.mock.calls.map(([text]) => text.length)
    // Present before bounded: no call at all would satisfy the bound.
    expect(lengths.length).toBeGreaterThan(0)
    expect(Math.max(...lengths)).toBeLessThanOrEqual(256)
  })
})

/**
 * Code points the font substitutes together with what precedes them: the
 * combining marks its ccmp composes onto `i`, `j` and `l` (dropping the dot,
 * 0.07-1.7px at 16px when the mark is measured apart from its base) and a
 * joiner. Written as numbers because each is invisible in source. The face
 * carries no variation selector, so one never reaches opentype in a run.
 */
const JOINING = [0x300, 0x301, 0x302, 0x307, 0x308, 0x323, 0x327, 0x200d].map((cp) =>
  String.fromCodePoint(cp),
)
const DOTTED = ['i', 'j', 'l', String.fromCodePoint(0x12f)]
const PLAIN = [...'abcdefghmnoxyzIJ0123456789 .,-?']

/**
 * Dense in joining code points, so a cut placed without regard to them lands
 * on one in most runs — the careless cut below is what proves that, rather
 * than the density being assumed.
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

describe('segmenting a run against measuring it whole', () => {
  let font: opentype.Font
  let carelessCutsCaught = 0

  beforeAll(async () => {
    const path = (await resolveExportFontFaces()).regular
    if (path === null) throw new Error('the vendored Regular face did not resolve')
    font = opentypeApi.parse((await readFile(path)).buffer)
    // A code point the face lacks never reaches opentype as part of a run.
    for (const char of [...JOINING, ...DOTTED, ...PLAIN]) {
      expect(font.charToGlyphIndex(char), char.codePointAt(0)?.toString(16)).not.toBe(0)
    }
  })

  afterAllFloor(['sums to what one opentype call measures for the whole run'], () => {
    // Reachability: a cut every 64 code points regardless of what follows
    // must be WRONG in a good share of runs, or the property passes whatever
    // rule the measurer cuts by. Measured at 14-23 runs of 60 over six runs.
    expect(carelessCutsCaught).toBeGreaterThan(NUM_RUNS / 10)
  })

  fcTest.prop(
    [runArbitrary, fc.constantFrom(11, 13.5, 16, 21)],
    withDefaults({ numRuns: NUM_RUNS }),
  )('sums to what one opentype call measures for the whole run', async (text, sizePx) => {
    const measure = await opentypeMeasureText()
    const advanceOf = (run: string) => font.getAdvanceWidth(run, sizePx, { kerning: false })
    const whole = advanceOf(text)

    const codePoints = Array.from(text)
    let careless = 0
    for (let start = 0; start < codePoints.length; start += 64) {
      careless += advanceOf(codePoints.slice(start, start + 64).join(''))
    }
    if (Math.abs(careless - whole) > 1e-9) carelessCutsCaught++

    expect(measure(text, descriptor(sizePx)).advanceWidth).toBeCloseTo(whole, 9)
  })
})
