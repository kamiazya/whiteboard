import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { describeMeasure, type FontDescriptor, type MeasureText } from '../measure.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { testLayoutCore } from '../test-utils/test-layout-core.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import { layoutSpatialCanvas } from './spatial-canvas.js'

/**
 * What a layout costs the host measurer (ADR-0054 step 7): the core asks a
 * `host` measurer across the wasm boundary, and memoises its answers within
 * one layout, so each distinct (text, font) crosses at most once however often
 * the layout measures it. The text-wrapping scoreboard's `measure` column
 * (q84: 812 → 580 when the core took the layout over) is this memo's price,
 * and this test is what holds the memo itself.
 */
const key = (text: string, font: FontDescriptor): string =>
  JSON.stringify([text, font.family, font.weight, font.style, font.sizePx])

function counting() {
  const fake = createFakeMeasure(0.6)
  const asked: string[] = []
  const measure: MeasureText = describeMeasure(
    (text, font) => {
      asked.push(key(text, font))
      return fake(text, font)
    },
    { kind: 'host' },
  )
  return { measure, asked }
}

// Every note says the same thing, so a layout that measured per node would
// ask for each word once per note.
const NOTES = 24
const board = {
  nodes: Array.from({ length: NOTES }, (_, n) =>
    textNode({
      id: `n${n}`,
      x: (n % 6) * 240,
      y: Math.floor(n / 6) * 160,
      width: 200,
      height: 120,
      text: 'the same words wrap the same way in every note on this board',
    }),
  ),
  edges: [],
}

describe('the host measurer, asked by the core', () => {
  it('crosses once per distinct text and font within one layout', () => {
    const { measure, asked } = counting()
    layoutSpatialCanvas(board, {
      core: testLayoutCore(),
      measure,
      appearance: createSpatialTheme({ mode: 'light' }),
    })
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.length).toBe(new Set(asked).size)
  })

  it('costs a board of identical notes what one note costs', () => {
    const one = counting()
    const many = counting()
    const options = { core: testLayoutCore(), appearance: createSpatialTheme({ mode: 'light' }) }
    layoutSpatialCanvas({ nodes: board.nodes.slice(0, 1), edges: [] }, { ...options, ...one })
    layoutSpatialCanvas(board, { ...options, ...many })
    expect(new Set(many.asked)).toEqual(new Set(one.asked))
    expect(many.asked.length).toBe(one.asked.length)
  })
})
