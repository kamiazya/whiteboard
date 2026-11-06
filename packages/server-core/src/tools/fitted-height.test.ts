import { fittedTextNodeHeight } from '@kamiazya/whiteboard-canvas-render'
import { createFixedMeasure } from '@kamiazya/whiteboard-canvas-render/test-utils'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { fittedHeight } from './canvas-edit-session.js'

const node = textNode({
  id: 'n',
  x: 0,
  y: 0,
  width: 200,
  height: 1,
  text: 'A sentence long enough to wrap over several lines at this width, and then some.',
})

describe('fittedHeight', () => {
  // The same helper the editor grows a committed text node with, so the box
  // an agent creates and the box a person grows agree for the same text.
  it.each([
    ['narrower than the ratio floor', (t: string) => t.length * 2],
    ['wider than the ratio floor', (t: string) => t.length * 12],
  ])('is the shared fitted height for a face %s', (_label, advance) => {
    const measure = createFixedMeasure({ advance, ascent: 10, descent: 2 })
    expect(fittedHeight(node, measure, 0)).toBe(fittedTextNodeHeight(node, { measure }))
  })

  it('never answers below the fallback it was given', () => {
    const measure = createFixedMeasure({ advance: 1, ascent: 1, descent: 0 })
    expect(fittedHeight(node, measure, 10_000)).toBe(10_000)
  })
})
