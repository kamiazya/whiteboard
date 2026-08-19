// The agent-facing verdict a DEGRADED measurer decides: `wb_scene_digest`
// reports `truncated` per node, and when no real measurer is injected the
// estimator is what lays the scene out. One that thinks Japanese is half as
// wide as it is tells an agent a node hides nothing while the editor is
// showing the reader a fade.
import { constantRatioMeasureText, layoutSpatialCanvas } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'

const APPEARANCE = { resolveNode: () => ({}), resolveEdge: () => ({}), resolveLabel: () => ({}) }

function truncatedOf(text: string, width: number, height: number): boolean {
  const canvas: SpatialCanvas = {
    nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width, height, text }],
    edges: [],
  }
  const scene = layoutSpatialCanvas(canvas, {
    measure: constantRatioMeasureText,
    appearance: APPEARANCE,
  })
  const shape = scene.nodes.find((node) => node.kind === 'shape')
  return (shape as { truncated?: true } | undefined)?.truncated === true
}

describe('the truncation verdict a Japanese canvas gets from a degraded measurer', () => {
  it('sees the wrap that a half-width model missed', () => {
    // 18 fullwidth characters in a 200px box: 18 em = 288px of ink against
    // 184px of content width, so it wraps to two lines and the second does
    // not fit a 32px-high node. A 0.55/char model put the same text at 158px
    // — one line — and reported nothing hidden.
    expect(truncatedOf('これは日本語のテキストで折り返します', 200, 32)).toBe(true)
  })

  it('leaves a node that genuinely fits alone', () => {
    expect(truncatedOf('これは日本語のテキストで折り返します', 200, 400)).toBe(false)
  })

  it('does not start truncating Latin text that used to fit', () => {
    expect(truncatedOf('short latin line', 200, 32)).toBe(false)
  })
})
