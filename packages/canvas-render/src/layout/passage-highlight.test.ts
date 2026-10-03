import type { TextQuoteSelector } from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { layoutMdastBlocks } from './nodes/mdast-blocks.js'
import { passageBoxes } from './passage-highlight.js'

const options = { measure: createFakeMeasure(), maxWidth: 2000, fontFamily: 'sans-serif' }

/**
 * One paragraph laid out as one run, so a box's offset inside it is the
 * passage's character offset times the fake measure's advance per character.
 */
function runOf(text: string) {
  const runs = layoutMdastBlocks(
    {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
    } as MdastRoot,
    options,
  ).nodes.flatMap((node) => ('runs' in node ? [...(node.runs ?? [])] : []))
  expect(runs).toHaveLength(1)
  return runs
}

/** The character offset the highlight starts at, or null when there is none. */
function startOf(text: string, quote: TextQuoteSelector): number | null {
  const runs = runOf(text)
  const boxes = passageBoxes(runs, quote, options.measure)
  if (boxes.length === 0) return null
  expect(boxes).toHaveLength(1)
  const [box] = boxes
  const perChar = box.w / quote.exact.length
  return Math.round((box.x - runs[0].bbox.x) / perChar)
}

describe('a passage highlight picks the occurrence whose surroundings match best', () => {
  const rendered = 'alpha foo omega beta foo gamma'
  const first = rendered.indexOf('foo')
  const last = rendered.lastIndexOf('foo')

  it('uses the prefix to choose between two identical quotes', () => {
    expect(startOf(rendered, { exact: 'foo', prefix: 'beta ' })).toBe(last)
  })

  it('uses the suffix when there is no prefix', () => {
    expect(startOf(rendered, { exact: 'foo', suffix: ' omega' })).toBe(first)
    expect(startOf(rendered, { exact: 'foo', suffix: ' gamma' })).toBe(last)
  })

  it('gives a tie to the first occurrence', () => {
    expect(startOf(rendered, { exact: 'foo' })).toBe(first)
  })

  it('keeps the best of three occurrences against a later weaker one', () => {
    const text = 'x foo y. a foo b. foo'
    expect(startOf(text, { exact: 'foo', prefix: 'a ', suffix: ' b' })).toBe(
      text.indexOf('a foo') + 2,
    )
  })

  it('draws nothing for a blank or absent quote', () => {
    expect(startOf(rendered, { exact: '  ' })).toBeNull()
    expect(startOf(rendered, { exact: 'missing' })).toBeNull()
  })
})
