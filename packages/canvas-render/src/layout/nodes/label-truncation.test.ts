import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fileNode, groupNode, linkNode } from '@kamiazya/whiteboard-model/test-utils'
import type { TextRunNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
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

type LabelBox = { id: string; x: number; y: number; width: number; height: number }

describe('label truncation', () => {
  it.each([
    ['file', (box: LabelBox) => fileNode({ ...box, file: 'とても長い日本語のファイル名です.md' })],
    ['link', (box: LabelBox) => linkNode({ ...box, url: 'https://example.com/very/long/path/x' })],
    ['group', (box: LabelBox) => groupNode({ ...box, label: 'とても長いグループのラベル' })],
  ])('keeps a %s label inside its node and marks it truncated', (_kind, build) => {
    const canvas: SpatialCanvas = {
      nodes: [build({ id: 'n', x: 0, y: 0, width: NODE_WIDTH, height: 60 })],
      edges: [],
    }
    const runs = runsOf(canvas)
    expect(runs.length).toBeGreaterThan(0)
    for (const run of runs) {
      expect(run.bbox.x + run.bbox.w).toBeLessThanOrEqual(NODE_WIDTH)
      expect(run.truncated).toBe(true)
    }
  })

  it('leaves a label that already fits untouched and unmarked', () => {
    const canvas: SpatialCanvas = {
      nodes: [fileNode({ id: 'n', x: 0, y: 0, width: NODE_WIDTH, height: 60, file: 'a.md' })],
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
