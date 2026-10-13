// @vitest-environment node

import { naturalNodeContentSize } from '@kamiazya/whiteboard-canvas-render'
import { createFixedMeasure } from '@kamiazya/whiteboard-canvas-render/test-utils'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { createEditorAppearance } from './editor-appearance.js'
import { requiredTextNodeHeight } from './scene-render.js'

const measure = createFixedMeasure({
  advance: (text) => text.length * 6,
  ascent: 10,
  descent: 2,
})

describe('requiredTextNodeHeight', () => {
  it('is the laid-out body plus the node padding above and below it', () => {
    // The editor grows a committed text node to exactly this height, so a
    // shortfall here is a last line clipped against the border.
    const node = textNode({
      id: 'n',
      x: 0,
      y: 0,
      width: 200,
      height: 1,
      text: '# Heading\n\n- one\n- two\n\nA closing line.',
    })
    const body = naturalNodeContentSize(node, {
      measure,
      appearance: createEditorAppearance('light'),
    })
    expect(body.h).toBeGreaterThan(0)
    // 8px of padding (SPATIAL_THEME_GEOMETRY.paddingPx) on each side.
    expect(requiredTextNodeHeight(node, { measure })).toBe(body.h + 16)
  })
})
