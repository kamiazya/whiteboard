import type { FontDescriptor, MeasureText } from '@kamiazya/whiteboard-canvas-render'
import { afterAll, beforeAll, describe } from 'vitest'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'
import {
  _resetExportMeasureTextCacheForTests,
  createConstantRatioMeasureText,
  createOpentypeMeasureText,
} from './measure-text.js'

function font(sizePx: number): FontDescriptor {
  return { family: 'Roboto', fallbackChain: [], weight: 400, style: 'normal', sizePx }
}

// Excludes newlines (layout never passes measure() a newline-containing
// string per canvas-render's documented contract) and excludes characters
// outside common Latin/digit/punctuation to stay within the vendored
// font's guaranteed coverage.
const textArbitrary = fc.stringMatching(/^[A-Za-z0-9 .,:;!?()'"-]*$/, { size: 'small' })
const nonEmptyTextArbitrary = fc.stringMatching(/^[A-Za-z0-9 .,:;!?()'"-]+$/, { size: 'small' })
const sizePxArbitrary = fc.double({ min: 1, max: 200, noNaN: true })
const scaleArbitrary = fc.double({ min: 0.1, max: 10, noNaN: true })

function runContractProperties(getMeasure: () => MeasureText, label: string) {
  fcTest.prop([textArbitrary, sizePxArbitrary], withDefaults())(
    `${label}: all metrics are finite and non-negative`,
    (text, sizePx) => {
      const metrics = getMeasure()(text, font(sizePx))
      for (const value of Object.values(metrics)) {
        if (!Number.isFinite(value) || value < 0) return false
      }
      return true
    },
  )

  fcTest.prop([sizePxArbitrary], withDefaults())(
    `${label}: empty string always measures advanceWidth 0`,
    (sizePx) => getMeasure()('', font(sizePx)).advanceWidth === 0,
  )

  fcTest.prop([nonEmptyTextArbitrary, sizePxArbitrary, scaleArbitrary], withDefaults())(
    `${label}: scales linearly with sizePx`,
    (text, sizePx, scale) => {
      const measure = getMeasure()
      const base = measure(text, font(sizePx))
      const scaled = measure(text, font(sizePx * scale))
      const tolerance = 0.02
      const relativeDiff = (actual: number, expected: number) =>
        expected === 0 ? Math.abs(actual) < 1e-6 : Math.abs(actual - expected) / expected
      return (
        relativeDiff(scaled.advanceWidth, base.advanceWidth * scale) <= tolerance &&
        relativeDiff(scaled.ascent, base.ascent * scale) <= tolerance &&
        relativeDiff(scaled.descent, base.descent * scale) <= tolerance
      )
    },
  )

  fcTest.prop(
    [nonEmptyTextArbitrary, fc.string({ minLength: 1, maxLength: 5 }), sizePxArbitrary],
    withDefaults(),
  )(`${label}: appending characters never decreases advanceWidth`, (text, suffix, sizePx) => {
    const measure = getMeasure()
    const shorter = measure(text, font(sizePx)).advanceWidth
    const longer = measure(text + suffix, font(sizePx)).advanceWidth
    return longer >= shorter - 1e-9
  })
}

describe('measure-text properties: createConstantRatioMeasureText', () => {
  runContractProperties(() => createConstantRatioMeasureText(), 'constant-ratio')
})

describe('measure-text properties: createOpentypeMeasureText (real font)', () => {
  let realMeasure: MeasureText

  beforeAll(async () => {
    realMeasure = await createOpentypeMeasureText()
  })

  afterAll(() => {
    _resetExportMeasureTextCacheForTests()
  })

  runContractProperties(() => realMeasure, 'opentype')
})
