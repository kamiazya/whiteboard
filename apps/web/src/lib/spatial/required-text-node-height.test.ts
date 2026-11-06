// @vitest-environment node

import { constantRatioMeasureText, fittedTextNodeHeight } from '@kamiazya/whiteboard-canvas-render'
import { createFixedMeasure } from '@kamiazya/whiteboard-canvas-render/test-utils'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { requiredTextNodeHeight } from './scene-render.js'

const node = textNode({
  id: 'n',
  x: 0,
  y: 0,
  width: 200,
  height: 1,
  text: '# Heading\n\n- one\n- two\n\nA closing line long enough to wrap at this width.',
})

describe('requiredTextNodeHeight', () => {
  // The editor grows a committed text node to this height and an agent's
  // wb_canvas_edit sizes one with the same canvas-render helper, so a box a
  // person grows and a box an agent creates are the same size for the same
  // text. A face narrower than the ratio measurer is the case that tells
  // the shared helper apart from a local reading of the editor's own font.
  it.each([
    ['narrower than the ratio floor', (t: string) => t.length * 2],
    ['wider than the ratio floor', (t: string) => t.length * 12],
  ])('is the shared fitted height for a face %s', (_label, advance) => {
    const measure = createFixedMeasure({ advance, ascent: 10, descent: 2 })
    expect(requiredTextNodeHeight(node, { measure })).toBe(fittedTextNodeHeight(node, { measure }))
    expect(requiredTextNodeHeight(node, { measure })).toBeGreaterThanOrEqual(
      fittedTextNodeHeight(node, { measure: constantRatioMeasureText }),
    )
  })
})
