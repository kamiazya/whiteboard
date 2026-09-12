/**
 * A comment's passage can be anchored across an inline formatting boundary.
 *
 * Found while adding inline images, and NOT caused by them: measured
 * identically on the code before that change, and reproducing on plain
 * `*emphasis*` with no image anywhere. Any inline boundary — emphasis,
 * strong, a link, inline code — splits a paragraph into runs, and layout
 * encodes the space between two words as an x OFFSET rather than as text.
 * `renderedTextOf` put a space back only at a line WRAP, so a same-line
 * split concatenated to `seea diagramhere` and the quote
 * `see\s+a\s+diagram\s+here` matched nothing.
 *
 * Measured before the fix: `3 runs ["see","a diagram","here"] span=0`
 * against `1 run  ["see a diagram here"] span=1` for the same sentence
 * written without the emphasis. A comment on a sentence containing a bold
 * word silently lost its highlight.
 */
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { layoutMdastBlocks } from './nodes/mdast-blocks.js'
import { passageBoxes } from './passage-highlight.js'

const options = { measure: createFakeMeasure(), maxWidth: 600, fontFamily: 'sans-serif' }

const runsOf = (children: object[]) =>
  layoutMdastBlocks(
    { type: 'root', children: [{ type: 'paragraph', children }] } as MdastRoot,
    options,
  ).nodes.flatMap((node) => ('runs' in node ? [...(node.runs ?? [])] : []))

const spans = (children: object[], exact: string) =>
  passageBoxes(runsOf(children), { exact }, options.measure).length

const QUOTE = 'see a diagram here'

describe('a passage spans an inline boundary', () => {
  it('anchors across emphasis', () => {
    expect(
      spans(
        [
          { type: 'text', value: 'see ' },
          { type: 'emphasis', children: [{ type: 'text', value: 'a diagram' }] },
          { type: 'text', value: ' here' },
        ],
        QUOTE,
      ),
    ).toBeGreaterThan(0)
  })

  it('anchors across a link', () => {
    expect(
      spans(
        [
          { type: 'text', value: 'see ' },
          { type: 'link', url: 'x', children: [{ type: 'text', value: 'a diagram' }] },
          { type: 'text', value: ' here' },
        ],
        QUOTE,
      ),
    ).toBeGreaterThan(0)
  })

  /** The control: the same sentence with no boundary always worked. */
  it('still anchors plain prose', () => {
    expect(spans([{ type: 'text', value: QUOTE }], QUOTE)).toBeGreaterThan(0)
  })

  /**
   * A boundary with NO space around it must not gain one: `**bold**face`
   * is one word, and inserting a space would both mis-place the highlight
   * and let a quote match text the document does not contain.
   */
  it('inserts nothing where the source had no space', () => {
    const children = [
      { type: 'strong', children: [{ type: 'text', value: 'bold' }] },
      { type: 'text', value: 'face' },
    ]
    expect(spans(children, 'boldface')).toBeGreaterThan(0)
    expect(spans(children, 'bold face')).toBe(0)
  })
})
