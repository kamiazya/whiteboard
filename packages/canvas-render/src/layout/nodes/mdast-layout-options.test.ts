import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../../test-utils/fake-measure.js'
import { MARKDOWN_THEME_NODE } from '../../theme/markdown-theme.js'
import { createNestedLayoutBudget } from './embed-budget.js'
import {
  codeLineHeightPx,
  placeFragment,
  type ResolvedMdastOptions,
} from './mdast-layout-options.js'

const options: ResolvedMdastOptions = {
  measure: createFakeMeasure(),
  maxWidth: 240,
  fontFamily: 'sans-serif',
  theme: MARKDOWN_THEME_NODE,
  nestedLayoutBudget: createNestedLayoutBudget(),
}

function place(fragment: { svg: string; width?: number; height?: number }) {
  return placeFragment(fragment, { x: 0, y: 10 }, options)
}

describe('placeFragment', () => {
  it('sizes a fragment from the dimensions its renderer reported, width clamped to the column', () => {
    expect(place({ svg: '<g/>', width: 100, height: 50 }).bbox).toEqual({
      x: 0,
      y: 10,
      w: 100,
      h: 50,
    })
    expect(place({ svg: '<g/>', width: 999, height: 50 }).bbox.w).toBe(240)
  })

  // A zero dimension is a renderer that measured nothing (a diagram that
  // failed to lay out, an empty typeset), not a fragment meant to vanish:
  // a zero-height box would stack the next block on top of it.
  it('reads a zero width or height as unreported and falls back to the column and one code line', () => {
    const fragment = place({ svg: '<g/>', width: 0, height: 0 })
    expect(fragment.bbox.w).toBe(240)
    expect(fragment.bbox.h).toBe(codeLineHeightPx(MARKDOWN_THEME_NODE))
    expect(fragment.bbox.h).toBeGreaterThan(0)
  })

  it('advances the cursor past the fragment by its height and the block gap', () => {
    const cursor = { x: 0, y: 10 }
    placeFragment({ svg: '<g/>', width: 0, height: 0 }, cursor, options)
    expect(cursor.y).toBe(
      10 + codeLineHeightPx(MARKDOWN_THEME_NODE) + MARKDOWN_THEME_NODE.blockGapPx,
    )
  })
})
