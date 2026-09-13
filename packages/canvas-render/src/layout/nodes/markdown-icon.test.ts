/**
 * `:icon-star:` is drawn as the vendored star wherever a BODY is drawn.
 *
 * The sibling of `markdown-shortcode.test.ts`, and here for the same reason
 * it is: this is the one place a text node's string reaches layout, so every
 * surface that draws a body gets it from one change and none of them can be
 * the one that forgot.
 *
 * What makes an icon different from an emoji, and why it needed its own
 * path: an emoji is a CHARACTER, so the emoji projection is a string
 * substitution the run never notices. An icon is drawn geometry, so the run
 * has to carry a `paints` the painter reads — the same arm `paints` was
 * declared a closed union for when inline images landed.
 */
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../../test-utils/fake-measure.js'
import { layoutMdastBlocks } from './mdast-blocks.js'

const options = { measure: createFakeMeasure(), maxWidth: 600, fontFamily: 'sans-serif' }

function runsOf(root: MdastRoot) {
  const scene = layoutMdastBlocks(root, options)
  return scene.nodes.flatMap((node) => ('runs' in node ? (node.runs ?? []) : []))
}

const paragraph = (value: string): MdastRoot => ({
  type: 'root',
  children: [{ type: 'paragraph', children: [{ type: 'text', value }] }],
})

describe('an icon shortcode in a body is drawn as the icon', () => {
  it('carries the name on the run rather than substituting a character', () => {
    const painted = runsOf(paragraph(':icon-star:')).filter((run) => run.paints !== undefined)
    expect(painted).toHaveLength(1)
    expect(painted[0]?.paints).toEqual({ kind: 'icon', name: 'star' })
    // Not the literal source, or the box would be measured for twelve
    // characters and the icon would sit in a hole the width of a sentence.
    expect(painted[0]?.text).not.toContain('icon')
  })

  it('keeps the prose either side of it', () => {
    const runs = runsOf(paragraph('see :icon-star: here'))
    const text = runs.map((run) => run.text).join('')
    expect(text).toContain('see')
    expect(text).toContain('here')
    expect(runs.filter((run) => run.paints?.kind === 'icon')).toHaveLength(1)
  })

  it('draws two of them in one paragraph', () => {
    const names = runsOf(paragraph(':icon-star: then :icon-lock:'))
      .map((run) => (run.paints?.kind === 'icon' ? run.paints.name : undefined))
      .filter((name) => name !== undefined)
    expect(names).toEqual(['star', 'lock'])
  })

  /**
   * The case that keeps this safe on documents written before it existed: a
   * colon pair naming no vendored icon reaches the canvas verbatim, because
   * the alternative is a renderer that eats text somebody wrote.
   */
  it('draws a colon pair naming no vendored icon exactly as written', () => {
    const runs = runsOf(paragraph('see :icon-nosuch: here'))
    expect(runs.map((run) => run.text).join(' ')).toContain(':icon-nosuch:')
    expect(runs.filter((run) => run.paints !== undefined)).toEqual([])
  })

  it('leaves one inside inline code alone, as the emoji rule already does', () => {
    const root: MdastRoot = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'inlineCode', value: ':icon-star:' }] }],
    }
    const runs = runsOf(root)
    expect(runs.map((run) => run.text).join(' ')).toContain(':icon-star:')
    expect(runs.filter((run) => run.paints !== undefined)).toEqual([])
  })

  /**
   * The two vocabularies in one line. `star` is a name in BOTH tables, which
   * is the collision the `icon-` prefix exists for.
   */
  it('draws the emoji star and the icon star differently in one paragraph', () => {
    const runs = runsOf(paragraph(':star: :icon-star:'))
    expect(runs.map((run) => run.text).join('')).toContain('⭐')
    expect(runs.filter((run) => run.paints?.kind === 'icon')).toHaveLength(1)
  })
})
