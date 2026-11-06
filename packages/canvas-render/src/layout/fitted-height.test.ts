import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { constantRatioMeasureText } from '../measure.js'
import { createFixedMeasure } from '../test-utils/fake-measure.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import { fittedTextNodeHeight } from './fitted-height.js'
import { naturalNodeContentSize } from './spatial-canvas.js'

const appearance = createSpatialTheme({ mode: 'light' })
const node = textNode({
  id: 'n',
  x: 0,
  y: 0,
  width: 160,
  height: 1,
  text: 'A sentence long enough to wrap over several lines at this width.',
})
const bodyUnder = (measure: Parameters<typeof naturalNodeContentSize>[1]['measure']) =>
  naturalNodeContentSize(node, { measure, appearance }).h

// 8px of padding (SPATIAL_THEME_GEOMETRY.paddingPx) above and below the body.
const PADDING = 16

describe('fittedTextNodeHeight', () => {
  it('never answers less than the ratio measurer needs, however narrow the font', () => {
    // A face narrower than the ratio wraps into fewer lines; the box is still
    // sized for the ratio, so a wider reader of the same canvas sees no cut.
    const narrow = createFixedMeasure({ advance: (t) => t.length * 2, ascent: 10, descent: 2 })
    expect(bodyUnder(narrow)).toBeLessThan(bodyUnder(constantRatioMeasureText))
    expect(fittedTextNodeHeight(node, { measure: narrow })).toBe(
      bodyUnder(constantRatioMeasureText) + PADDING,
    )
  })

  it("answers the measure's own reading when that is the taller", () => {
    const wide = createFixedMeasure({ advance: (t) => t.length * 14, ascent: 10, descent: 2 })
    expect(bodyUnder(wide)).toBeGreaterThan(bodyUnder(constantRatioMeasureText))
    expect(fittedTextNodeHeight(node, { measure: wide })).toBe(bodyUnder(wide) + PADDING)
  })

  it("answers the measure's own reading alone when the caller declines the floor", () => {
    const narrow = createFixedMeasure({ advance: (t) => t.length * 2, ascent: 10, descent: 2 })
    expect(fittedTextNodeHeight(node, { measure: narrow, floor: 'none' })).toBeLessThan(
      fittedTextNodeHeight(node, { measure: narrow }),
    )
  })
})
