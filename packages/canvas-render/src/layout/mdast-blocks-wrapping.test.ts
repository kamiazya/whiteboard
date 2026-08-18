import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import type { ParagraphBlockNode, TextRunNode } from '../scene-graph.js'
import { createCorpusMeasure } from '../test-utils/text-wrapping-corpus.js'
import { layoutMdastBlocks } from './mdast-blocks.js'

/**
 * Line breaking for text with no spaces in it — Japanese, Chinese, a URL, an
 * unbroken identifier. The greedy space-only wrap this replaced could not
 * even ASK whether such a string fits: it required a space to be present
 * before it would consider wrapping at all, so a Japanese paragraph was
 * emitted as one run and painted straight through its node's border.
 */

const MAX_WIDTH = 200

function layout(root: MdastRoot, maxWidth = MAX_WIDTH) {
  const counting = createCorpusMeasure()
  return layoutMdastBlocks(root, {
    measure: counting.measure,
    maxWidth,
    fontFamily: 'Roboto',
  })
}

const paragraphOf = (value: string): MdastRoot => ({
  type: 'root',
  children: [{ type: 'paragraph', children: [{ type: 'text', value }] }],
})

function runsOf(root: MdastRoot, maxWidth = MAX_WIDTH): readonly TextRunNode[] {
  return layout(root, maxWidth).nodes.flatMap((node) =>
    node.kind === 'paragraph' || node.kind === 'heading' ? node.runs : [],
  )
}

/** Runs grouped into lines by their y, each line's text in painting order. */
function linesOf(root: MdastRoot, maxWidth = MAX_WIDTH): readonly string[] {
  const byLine = new Map<number, TextRunNode[]>()
  for (const run of runsOf(root, maxWidth)) {
    const line = byLine.get(run.bbox.y) ?? []
    line.push(run)
    byLine.set(run.bbox.y, line)
  }
  return [...byLine.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, runs]) => {
      // Whitespace between runs is carried as a CURSOR ADVANCE, not as
      // characters (XML strips a run's boundary whitespace), so the painted
      // line is reconstructed from the horizontal gaps, not from the texts.
      let text = ''
      let right = 0
      for (const run of [...runs].sort((a, b) => a.bbox.x - b.bbox.x)) {
        if (text !== '' && run.bbox.x > right + 0.01) text += ' '
        text += run.text
        right = run.bbox.x + run.bbox.w
      }
      return text
    })
}

/**
 * Captured from the space-only wrapper BEFORE this change, so the new breaker
 * has to reproduce it exactly: English already wrapped correctly, and a line
 * breaker that "fixes" it has changed something nobody asked it to.
 */
const ENGLISH_LINES_BEFORE = ['This is a fairly', 'long English', 'sentence that should', 'wrap.']

const JA =
  'これは日本語の長い文章です。ノードの幅を超えても折り返されるべきですが、実際に測ります。'

describe('line breaking without spaces', () => {
  it('wraps Japanese prose inside maxWidth', () => {
    const runs = runsOf(paragraphOf(JA))
    expect(runs.length).toBeGreaterThan(1)
    for (const run of runs) {
      expect(run.bbox.x + run.bbox.w).toBeLessThanOrEqual(MAX_WIDTH)
    }
  })

  it('wraps Chinese prose inside maxWidth', () => {
    for (const run of runsOf(paragraphOf('这是一段很长的中文文本，应该在节点的宽度处换行。'))) {
      expect(run.bbox.x + run.bbox.w).toBeLessThanOrEqual(MAX_WIDTH)
    }
  })

  it('never starts a line with a closing character or ends one with an opening character', () => {
    const lines = linesOf(
      paragraphOf('これは日本語です。（括弧）と「かぎ括弧」があります、ね。終わり。'),
    )
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      expect(line).not.toMatch(/^[。、）」』，！？]/)
      expect(line).not.toMatch(/[（「『]$/)
    }
  })

  it('breaks a long URL at its path separators', () => {
    const lines = linesOf(
      paragraphOf('https://example.com/very/long/path/that/never/breaks/at/all'),
    )
    expect(lines.length).toBeGreaterThan(1)
    // Every line but the last ends where a UAX #14 break opportunity is, which
    // for a URL is after a slash — never mid-token when a separator was available.
    for (const line of lines.slice(0, -1)) {
      expect(line.endsWith('/')).toBe(true)
    }
  })

  it('breaks an unbreakable token by character rather than overflowing', () => {
    const runs = runsOf(paragraphOf('SupercalifragilisticexpialidociousAndThenSomeMore'))
    expect(runs.length).toBeGreaterThan(1)
    for (const run of runs) {
      expect(run.bbox.x + run.bbox.w).toBeLessThanOrEqual(MAX_WIDTH)
    }
  })

  it('emits one run per line, not one per break opportunity', () => {
    // The cheapest way to make Japanese fit is to emit every character as its
    // own run. That fits, and it multiplies the SVG's <text> elements by the
    // character count — so the contract is that a line is ONE run.
    const lines = linesOf(paragraphOf(JA))
    expect(lines.length).toBeGreaterThan(1)
    expect(runsOf(paragraphOf(JA))).toHaveLength(lines.length)
  })

  it('leaves already-fitting English wrapping untouched', () => {
    expect(
      linesOf(paragraphOf('This is a fairly long English sentence that should wrap.')),
    ).toEqual(ENGLISH_LINES_BEFORE)
  })

  it("declares a block bbox that covers an atomic run's overflow", () => {
    // Inline code is atomic by contract — an internal space is not a word
    // boundary — so it can still exceed maxWidth. What must not happen is the
    // block claiming to be maxWidth wide while painting past it: sceneBounds,
    // the export viewBox and the editor's auto-fit all read that bbox.
    const scene = layout({
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'inlineCode', value: 'layoutMdastBlocks(root, options, andMore)' }],
        },
      ],
    })
    const block = scene.nodes.find((node): node is ParagraphBlockNode => node.kind === 'paragraph')
    expect(block).toBeDefined()
    if (block === undefined) return
    const inkRight = Math.max(...block.runs.map((run) => run.bbox.x + run.bbox.w))
    expect(block.bbox.x + block.bbox.w).toBeGreaterThanOrEqual(inkRight)
  })
})
