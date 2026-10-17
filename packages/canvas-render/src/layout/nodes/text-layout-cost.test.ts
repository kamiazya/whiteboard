import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import type { CodeBlockNode, ParagraphBlockNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import type { FontDescriptor, MeasureText, TextMetrics } from '../../measure.js'
import { constantRatioMeasureText } from '../../measure.js'
import { typesetMdastBlocks } from './mdast-blocks.js'

/**
 * What one long line costs the measurer, COUNTED in characters handed to it
 * rather than timed, so the number is the same on any machine and under any
 * load. A node's width is unbounded, so a single text node can hold one line
 * as long as its whole body; a layout that re-measures the accumulated line
 * per step is quadratic in that length, and this is what would show it.
 *
 * The same five shapes through the daemon's opentype measurer at 8192
 * characters cost 0.2s (fits whole), 58s (prose one pixel under natural),
 * 0.4s (prose at 200), 301s (fence cut by one glyph) and 0.07s (fence at
 * 200) of CPU — the counts below are what those seconds are proportional to.
 */

const LENGTH = 8192

interface Counted {
  readonly measure: MeasureText
  readonly characters: () => number
}

function countingMeasure(): Counted {
  let characters = 0
  const measure = (text: string, font: FontDescriptor): TextMetrics => {
    characters += text.length
    return constantRatioMeasureText(text, font)
  }
  return { measure, characters: () => characters }
}

function prose(length: number): string {
  return 'Lorem ipsum dolor sit amet. '.repeat(Math.ceil(length / 28)).slice(0, length)
}

/** One line of code with no break opportunity a fence would honour anyway. */
function codeLine(length: number): string {
  return 'const value = compute(alpha, beta); '.repeat(Math.ceil(length / 36)).slice(0, length)
}

const paragraphOf = (value: string): MdastRoot => ({
  type: 'root',
  children: [{ type: 'paragraph', children: [{ type: 'text', value }] }],
})

const fenceOf = (value: string): MdastRoot => ({
  type: 'root',
  children: [{ type: 'code', value }],
})

function charactersMeasured(root: MdastRoot, maxWidth: number): number {
  const counted = countingMeasure()
  typesetMdastBlocks(root, { measure: counted.measure, maxWidth, fontFamily: 'Roboto' })
  return counted.characters()
}

/** The block width at which the fence's one line is cut by a single glyph. */
function widthJustUnderNatural(root: MdastRoot): number {
  const scene = typesetMdastBlocks(root, {
    measure: constantRatioMeasureText,
    maxWidth: 1e6,
    fontFamily: 'Roboto',
  })
  const block = scene.nodes.find((node): node is CodeBlockNode => node.kind === 'codeBlock')
  const run = block?.runs?.[0]
  if (block === undefined || run === undefined) throw new Error('fence laid out no run')
  const padding = run.bbox.x - block.bbox.x
  return run.bbox.w + 2 * padding - 1
}

/** The width at which the paragraph's one line no longer fits by a single pixel. */
function proseWidthJustUnderNatural(root: MdastRoot): number {
  const scene = typesetMdastBlocks(root, {
    measure: constantRatioMeasureText,
    maxWidth: 1e6,
    fontFamily: 'Roboto',
  })
  const paragraph = scene.nodes.find(
    (node): node is ParagraphBlockNode => node.kind === 'paragraph',
  )
  const run = paragraph?.runs[0]
  if (paragraph?.runs.length !== 1 || run === undefined) throw new Error('paragraph is not one run')
  return run.bbox.w - 1
}

describe('characters measured for one long line', () => {
  // A paragraph that fits its line whole is measured once and never wrapped,
  // so width 1e6 alone is the cheap case; the expensive one is a line that
  // holds nearly all of it and still has to be broken.
  it('prose paragraph that fits its line whole at width 1e6', () => {
    expect(charactersMeasured(paragraphOf(prose(LENGTH)), 1e6)).toBe(16_385)
  })

  it('prose paragraph wrapped one pixel under its natural width', () => {
    const root = paragraphOf(prose(LENGTH))
    expect(charactersMeasured(root, proseWidthJustUnderNatural(root))).toBe(6_012_640)
  })

  it('prose paragraph at width 200', () => {
    expect(charactersMeasured(paragraphOf(prose(LENGTH)), 200)).toBe(44_553)
  })

  it('code fence line cut by one glyph', () => {
    const root = fenceOf(codeLine(LENGTH))
    expect(charactersMeasured(root, widthJustUnderNatural(root))).toBe(33_574_911)
  })

  it('code fence line at width 200', () => {
    expect(charactersMeasured(fenceOf(codeLine(LENGTH)), 200)).toBe(8_490)
  })
})
