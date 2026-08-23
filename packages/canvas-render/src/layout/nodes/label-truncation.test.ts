import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import type { TextRunNode } from '../../scene-graph.js'
import { createCorpusMeasure } from '../../test-utils/text-wrapping-corpus.js'
import { layoutSpatialCanvas } from '../spatial-canvas.js'
import { layoutMdastBlocks } from './mdast-blocks.js'

/**
 * A node's label never wraps — one line is what makes a label a label — so
 * the only way to keep it inside the box is to cut it. It is cut to the
 * longest prefix that fits and marked `truncated`, which is what the SVG
 * backend paints a fade over: an ellipsis would spend the width it saves on
 * three dots, and a fade says "there is more" without claiming to know how
 * much.
 */
const bare = {
  measure: createCorpusMeasure().measure,
  parseBody: () => ({ type: 'root' as const, children: [] }),
  appearance: { resolveNode: () => ({}), resolveEdge: () => ({}), resolveLabel: () => ({}) },
}

function runsOf(canvas: SpatialCanvas): readonly TextRunNode[] {
  return layoutSpatialCanvas(canvas, bare).nodes.filter(
    (node): node is TextRunNode => node.kind === 'textRun',
  )
}

const NODE_WIDTH = 160

describe('label truncation', () => {
  it.each([
    ['file', { type: 'file' as const, file: 'とても長い日本語のファイル名です.md' }],
    ['link', { type: 'link' as const, url: 'https://example.com/very/long/path/x' }],
    ['group', { type: 'group' as const, label: 'とても長いグループのラベル' }],
  ])('keeps a %s label inside its node and marks it truncated', (_kind, rest) => {
    const canvas = {
      nodes: [{ id: 'n', x: 0, y: 0, width: NODE_WIDTH, height: 60, ...rest }],
      edges: [],
    } as SpatialCanvas
    const runs = runsOf(canvas)
    expect(runs.length).toBeGreaterThan(0)
    for (const run of runs) {
      expect(run.bbox.x + run.bbox.w).toBeLessThanOrEqual(NODE_WIDTH)
      expect(run.truncated).toBe(true)
    }
  })

  it('leaves a label that already fits untouched and unmarked', () => {
    const canvas: SpatialCanvas = {
      nodes: [{ id: 'n', type: 'file', x: 0, y: 0, width: NODE_WIDTH, height: 60, file: 'a.md' }],
      edges: [],
    }
    const [run] = runsOf(canvas)
    expect(run?.text).toBe('a.md')
    expect(run?.truncated).toBeUndefined()
  })

  it('truncates an atomic run rather than painting it past the wrap width', () => {
    // Inline code is never SPLIT — an interior space in a code span is not a
    // word boundary — which is why wrapping alone could not keep it in the
    // box. Cutting it is the remaining half.
    const scene = layoutMdastBlocks(
      {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [{ type: 'inlineCode', value: 'layoutMdastBlocks(root, options, andMore)' }],
          },
        ],
      },
      { measure: createCorpusMeasure().measure, maxWidth: 200, fontFamily: 'Roboto' },
    )
    const runs = scene.nodes.flatMap((node) => (node.kind === 'paragraph' ? node.runs : []))
    expect(runs.length).toBeGreaterThan(0)
    for (const run of runs) {
      expect(run.bbox.x + run.bbox.w).toBeLessThanOrEqual(200)
    }
    expect(runs.some((run) => run.truncated === true)).toBe(true)
  })
})
