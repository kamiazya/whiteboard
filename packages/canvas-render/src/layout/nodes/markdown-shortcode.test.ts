/**
 * `:grinning_face:` is drawn as 😀 wherever a BODY is drawn.
 *
 * Here rather than per-surface because this is the one place a text node's
 * string reaches layout — so the preview pane, a canvas node's body, a row
 * thumbnail, the PNG/SVG export and the MCP renderer all get it from one
 * change, and none of them can be the surface that forgot. That is the
 * `reference-seams` lesson applied by having no seam: a projection every
 * caller has to opt into is one a caller misses, and the miss is silent
 * because the layout is total.
 *
 * What it deliberately does NOT reach: the source pane, which shows what is
 * STORED and must keep showing `:grinning_face:` (the shortcode is the real
 * syntax — user decision, 2026-09-11), and inline code, where a shortcode is
 * being talked about rather than used.
 */
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../../test-utils/fake-measure.js'
import { layoutMdastBlocks } from './mdast-blocks.js'

const options = { measure: createFakeMeasure(), maxWidth: 600, fontFamily: 'sans-serif' }

/**
 * Every string the layout drew, in order.
 *
 * Off the `runs` of the block nodes rather than a `text` scene node — there
 * is no such kind, and the first version of this helper answered `''` for
 * every case, which made all four read as failing when the helper was what
 * was wrong. A red test has to be red for its own reason.
 */
function drawn(root: MdastRoot): string {
  const scene = layoutMdastBlocks(root, options)
  return scene.nodes
    .flatMap((node) => ('runs' in node ? (node.runs ?? []).map((run) => run.text) : []))
    .join(' ')
}

const paragraph = (value: string): MdastRoot => ({
  type: 'root',
  children: [{ type: 'paragraph', children: [{ type: 'text', value }] }],
})

describe('a shortcode in a body is drawn as its emoji', () => {
  it('replaces it in a paragraph', () => {
    expect(drawn(paragraph('ship it :rocket:'))).toContain('🚀')
  })

  it('replaces it in a heading, which is the same walk', () => {
    const root: MdastRoot = {
      type: 'root',
      children: [{ type: 'heading', depth: 1, children: [{ type: 'text', value: ':fire: hot' }] }],
    }
    expect(drawn(root)).toContain('🔥')
  })

  /**
   * The case that makes this safe on documents written before it existed: a
   * colon pair naming no emoji has to reach the canvas verbatim, because the
   * alternative is a renderer that eats text somebody wrote.
   */
  it('draws a colon pair that names no emoji exactly as written', () => {
    expect(drawn(paragraph('see :something: here'))).toContain(':something:')
    expect(drawn(paragraph('from 10:30: onwards'))).toContain('10:30:')
  })

  /**
   * Inside a code span the shortcode is the SUBJECT — a note explaining how
   * to type one would otherwise be unable to show it.
   */
  it('leaves a shortcode inside inline code alone', () => {
    const root: MdastRoot = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'inlineCode', value: ':rocket:' }] }],
    }
    const text = drawn(root)
    expect(text).toContain(':rocket:')
    expect(text).not.toContain('🚀')
  })
})
