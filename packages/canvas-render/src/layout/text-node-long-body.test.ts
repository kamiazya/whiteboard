/**
 * A text node's body goes through the same typesetter as a note's, so the
 * longest run with nowhere to break that a body can hold has to lay out here
 * too. One past ~64K code points once overflowed the stack inside the line
 * breaker, which this path caught, reported as a parse failure and drew as a
 * one-line label in place of the body.
 */

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { layoutSpatialCanvas, type SpatialLayoutDegradation } from './spatial-canvas.js'

const APPEARANCE = { resolveNode: () => ({}), resolveEdge: () => ({}), resolveLabel: () => ({}) }

describe('a text node whose body has no break opportunity', () => {
  it('is typeset into lines, not degraded to a label', () => {
    const canvas: SpatialCanvas = {
      nodes: [
        textNode({ id: 'long', x: 0, y: 0, width: 200, height: 100, text: 'x'.repeat(100_000) }),
      ],
      edges: [],
    }
    const onDegrade = vi.fn<(event: SpatialLayoutDegradation) => void>()
    const scene = layoutSpatialCanvas(canvas, {
      measure: createFakeMeasure(),
      appearance: APPEARANCE,
      onDegrade,
    })
    expect(onDegrade).not.toHaveBeenCalled()
    const runs = scene.nodes.flatMap((node) => (node.kind === 'paragraph' ? node.runs : []))
    expect(runs.length).toBeGreaterThan(1)
    expect(runs.every((run) => /^x+$/.test(run.text))).toBe(true)
  })
})
