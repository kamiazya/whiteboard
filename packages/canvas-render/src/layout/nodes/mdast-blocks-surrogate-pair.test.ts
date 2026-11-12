import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../../test-utils/fake-measure.js'
import { typesetMdastBlocks } from './mdast-blocks.js'

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

const paragraph = (value: string): MdastRoot => ({
  type: 'root',
  children: [{ type: 'paragraph', children: [{ type: 'text', value }] }],
})

describe('a Japanese phrase boundary inside a surrogate pair', () => {
  // BudouX reads UTF-16 units and names a boundary between the halves of the
  // emoji here; taking it would leave half a character in a run.
  it('is never a line break', () => {
    const input = '」👍っ日本語'
    const root = paragraph(input)
    for (let width = 20; width <= 80; width += 1) {
      const scene = typesetMdastBlocks(root, {
        measure: createFakeMeasure(),
        maxWidth: width,
        fontFamily: 'sans-serif',
      })
      const texts = scene.nodes.flatMap((n) =>
        'runs' in n ? (n.runs ?? []).map((r) => r.text) : [],
      )
      // Without this a typesetter that dropped the emoji would have no half of it to find.
      expect(texts.join(''), `width ${width}`).toBe(input)
      expect(
        texts.some((t) => LONE_SURROGATE.test(t)),
        `width ${width}: ${texts}`,
      ).toBe(false)
    }
  })
})
