import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../../test-utils/fake-measure.js'
import { typesetMdastBlocks } from './mdast-blocks.js'

const options = { measure: createFakeMeasure(), maxWidth: 240, fontFamily: 'sans-serif' }

function codeBlockOf(value: string) {
  const root: MdastRoot = {
    type: 'root',
    children: [{ type: 'code', lang: null, meta: null, value }],
  }
  const code = typesetMdastBlocks(root, options).nodes.find((n) => n.kind === 'codeBlock')
  if (code === undefined || code.kind !== 'codeBlock') throw new Error('no codeBlock laid out')
  return { code, runs: code.runs ?? [] }
}

describe('layoutCodeBlock', () => {
  // SVG collapses newlines inside one `<text>`, so a fence whose lines share a
  // y paints every line on top of the first while its panel stays sized for all.
  it('places each source line exactly one line box below the previous one', () => {
    const { runs } = codeBlockOf('alpha\nbeta\ngamma\ndelta')
    expect(runs.map((r) => r.text)).toEqual(['alpha', 'beta', 'gamma', 'delta'])
    const lineBox = runs[0]?.bbox.h ?? 0
    expect(lineBox).toBeGreaterThan(0)
    const first = runs[0]?.bbox.y ?? 0
    expect(runs.map((r) => r.bbox.y)).toEqual(runs.map((_, i) => first + i * lineBox))
  })

  it('grows the panel by one line box per added source line', () => {
    const one = codeBlockOf('a')
    const three = codeBlockOf('a\nb\nc')
    const lineBox = one.runs[0]?.bbox.h ?? 0
    expect(lineBox).toBeGreaterThan(0)
    expect(three.code.bbox.h - one.code.bbox.h).toBe(2 * lineBox)
    const last = three.runs.at(-1)
    expect(last).toBeDefined()
    expect((last?.bbox.y ?? 0) + (last?.bbox.h ?? 0)).toBeLessThanOrEqual(
      three.code.bbox.y + three.code.bbox.h,
    )
  })
})
