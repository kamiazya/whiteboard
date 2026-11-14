/**
 * A passage inside a list item or a table cell is highlighted under the words
 * as they are DRAWN. Those two wrappers are the renderers that translate their
 * subtree by their own `bbox.x`, so the runs under them hold wrapper-relative
 * x; a highlight read off that x lands left of its words by the wrappers'
 * offsets, nested ones added together.
 *
 * The expected place is restated here rather than taken from the code under
 * test: the run's drawn x is its stored x plus every enclosing list item's
 * and table cell's x — the rule `sceneBounds` applies.
 */
import { parseMarkdownBody } from '@kamiazya/whiteboard-codec'
import type { SceneNode, TextRunNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { type SceneWalkNode, sceneChildrenOf } from '../scene-children.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { typesetMdastBlocks } from './nodes/mdast-blocks.js'
import { runFontOf } from './nodes/mdast-layout-options.js'
import { collectTextRuns, passageBoxes } from './passage-highlight.js'

const options = { measure: createFakeMeasure(), maxWidth: 600, fontFamily: 'sans-serif' }

const bodyOf = (source: string): readonly SceneNode[] =>
  typesetMdastBlocks(parseMarkdownBody(source), options).nodes

/** Every run with the x it is drawn at, by the sceneBounds rule. */
function drawnRuns(nodes: readonly SceneNode[]): { run: TextRunNode; x: number }[] {
  const out: { run: TextRunNode; x: number }[] = []
  const visit = (node: SceneWalkNode, offset: number): void => {
    if (node.kind === 'textRun') out.push({ run: node, x: node.bbox.x + offset })
    const own = node.kind === 'listItem' || node.kind === 'tableCell' ? node.bbox.x : 0
    for (const child of sceneChildrenOf(node) ?? []) visit(child, offset + own)
  }
  for (const node of nodes) visit(node, 0)
  return out
}

/** The one highlight box for `exact`, beside the drawn run that holds it whole. */
function highlightOf(source: string, exact: string) {
  const nodes = bodyOf(source)
  const boxes = passageBoxes(collectTextRuns(nodes), { exact }, options.measure)
  const drawn = drawnRuns(nodes).find(({ run }) => run.text.includes(exact))
  if (drawn === undefined) throw new Error(`no run holds ${exact}`)
  return { boxes, drawn }
}

describe('a passage highlight inside a wrapper that translates its subtree', () => {
  it('sits under its words inside a nested list item', () => {
    const { boxes, drawn } = highlightOf('- outer words\n  - inner target words', 'target')
    // The premise: the run's stored x is not where it is drawn.
    expect(drawn.x).not.toBe(drawn.run.bbox.x)
    const font = runFontOf(drawn.run)
    if (font === undefined) throw new Error('the run carries no font')
    const head = drawn.run.text.slice(0, drawn.run.text.indexOf('target'))
    const lead = options.measure(head, font).advanceWidth
    expect(boxes).toHaveLength(1)
    expect(boxes[0]?.x).toBe(drawn.x + lead)
  })

  it('sits under its words inside a table cell', () => {
    const { boxes, drawn } = highlightOf(
      '| left | right |\n| --- | --- |\n| one | target |',
      'target',
    )
    expect(drawn.x).not.toBe(drawn.run.bbox.x)
    expect(boxes).toHaveLength(1)
    expect(boxes[0]?.x).toBe(drawn.x)
  })

  it('reads the gap between two cells as a space, so a quote can span them', () => {
    const source = '| left | right |\n| --- | --- |\n| one | two |'
    const nodes = bodyOf(source)
    const boxes = passageBoxes(collectTextRuns(nodes), { exact: 'one two' }, options.measure)
    const drawn = drawnRuns(nodes)
    const one = drawn.find(({ run }) => run.text === 'one')
    const two = drawn.find(({ run }) => run.text === 'two')
    expect(boxes.map((box) => box.x)).toEqual([one?.x, two?.x])
  })
})
