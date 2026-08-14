/**
 * The claim this change exists to make, measured rather than felt: while a
 * large canvas is being laid out, the main thread keeps running.
 *
 * A canvas this size takes a few hundred ms to lay out, so on the synchronous
 * path the frame loop stalls for that whole window — which is the freeze a
 * user reports as "the app hung when I added a node". Counting animation
 * frames across the update is the direct observation of it; the mutation check
 * for this test is to disable offloading, which starves the counter.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const NODES = 45
const EDGES = 90

const heavy = (label: string): SpatialCanvas => ({
  nodes: Array.from({ length: NODES }, (_, i) => ({
    id: `n${i}`,
    type: 'text' as const,
    x: (i % 8) * 260,
    y: Math.floor(i / 8) * 180,
    width: 200,
    height: 120,
    text: i === 0 ? label : `node ${i} carries a sentence long enough to wrap somewhere`,
  })),
  edges: Array.from({ length: EDGES }, (_, i) => ({
    id: `e${i}`,
    fromNode: `n${i % NODES}`,
    toNode: `n${(i * 7 + 3) % NODES}`,
  })).filter((e) => e.fromNode !== e.toNode),
})

function Host() {
  const [canvas, setCanvas] = useState<SpatialCanvas>(heavy('first'))
  return (
    <div style={{ width: 1000, height: 700 }}>
      <button type="button" data-testid="edit" onClick={() => setCanvas(heavy('second'))}>
        edit
      </button>
      <SpatialEditor canvas={canvas} onChange={setCanvas} theme="light" />
    </div>
  )
}

it('keeps painting frames while a heavy canvas is laid out', async () => {
  const { container } = render(<Host />)
  expect(container.textContent ?? '').toContain('first')

  let frames = 0
  let running = true
  const tick = () => {
    if (!running) return
    frames += 1
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  screen.getByTestId('edit').click()
  await vi.waitFor(() => expect(container.textContent ?? '').toContain('second'), {
    timeout: 20_000,
  })
  running = false

  // A layout of this size blocks for hundreds of ms synchronously, which at
  // 60Hz is tens of frames lost. The bar is deliberately far below what a
  // free thread produces and far above what a blocked one can.
  expect(frames).toBeGreaterThan(5)
}, 40_000)
