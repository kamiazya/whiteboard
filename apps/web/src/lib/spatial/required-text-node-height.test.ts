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
  // The editor grows a committed text node to this height through the same
  // canvas-render helper wb_canvas_edit sizes an agent's node with, minus
  // the ratio floor: the font measured here is the one on screen, and the
  // floor left a third of a nine-line note empty in the running app. A face
  // narrower than the ratio measurer is the case that tells the two apart.
  it('is the shared fitted height without the ratio floor, for a face narrower or wider than it', () => {
    for (const advance of [(t: string) => t.length * 2, (t: string) => t.length * 12]) {
      const measure = createFixedMeasure({ advance, ascent: 10, descent: 2 })
      expect(requiredTextNodeHeight(node, { measure })).toBe(
        fittedTextNodeHeight(node, { measure, floor: 'none' }),
      )
    }
  })

  it('fits the narrow face on screen rather than the ratio floor', () => {
    const measure = createFixedMeasure({ advance: (t) => t.length * 2, ascent: 10, descent: 2 })
    expect(requiredTextNodeHeight(node, { measure })).toBeLessThan(
      fittedTextNodeHeight(node, { measure: constantRatioMeasureText }),
    )
  })
})
