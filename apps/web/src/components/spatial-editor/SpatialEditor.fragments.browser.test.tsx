/**
 * A text node's display math is typeset on the canvas, through the real
 * MathJax engine, on the path a board past the offload threshold takes: the
 * edit that introduces the math is laid out in the WORKER, which can only
 * report the source it could not answer — the main thread renders it and
 * the next request carries it back.
 */

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

// At the offload threshold, so every edit after the first paint is laid out in the worker.
const NODES = 12

const board = (first: string): SpatialCanvas => ({
  nodes: Array.from({ length: NODES }, (_, i) =>
    textNode({
      id: `n${i}`,
      x: (i % 4) * 260,
      y: Math.floor(i / 4) * 180,
      width: 220,
      height: 140,
      text: i === 0 ? first : `node ${i}`,
    }),
  ),
  edges: [],
})

// The canvas arrives as a prop and is replaced by rerendering, as a sync frame
// replaces it — no editor host is needed, since nothing here edits through the editor.
const frame = (canvas: SpatialCanvas) => (
  <div style={{ width: 1000, height: 700 }}>
    <SpatialEditor canvas={canvas} onChange={() => {}} theme="light" />
  </div>
)

it('typesets display math a worker-laid-out edit introduces into a text node', async () => {
  const { container, rerender } = render(frame(board('plain')))
  rerender(frame(board('$$\nx^2\n$$\n')))
  // MathJax's SVG output marks every node it typesets; the source fallback has none.
  await expect
    .poll(() => container.querySelector('[data-mml-node="math"]') !== null, { timeout: 20_000 })
    .toBe(true)
}, 30_000)
