/**
 * The claim this change exists to make, measured rather than felt: while a
 * large canvas is being laid out, the main thread keeps running — and it is
 * the WORKER doing it, not a canvas that happened to be cheap.
 *
 * Both assertions ride one interaction on purpose. Every other browser test
 * here uses a canvas well under the offload threshold, so this is the only
 * one exercising the wiring at all; but a canvas big enough to show a freeze
 * is also expensive to lay out, and two such tests measurably raised the
 * flake rate of the whole parallel project. One interaction, two questions.
 *
 * A canvas this size takes a few hundred ms to lay out, so on the synchronous
 * path the frame loop stalls for that whole window — which is the freeze a
 * user reports as "the app hung when I added a node". Counting animation
 * frames across the update is the direct observation of it; the mutation check
 * for this test is to disable offloading, which starves the counter.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { FONT_DEGRADED, type LayoutResponse } from '../../lib/layout-worker-protocol.js'
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

it('lays a heavy canvas out in the worker and keeps painting while it does', async () => {
  // Observing the Worker CONSTRUCTION is the only honest way to pin which
  // path ran. Asserting "the DOM has not caught up yet" does not: React
  // schedules the synchronous path's re-render too, so that assertion holds
  // either way — verified by watching it pass with offloading disabled.
  const RealWorker = globalThis.Worker
  const built: string[] = []
  globalThis.Worker = class extends RealWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      built.push(String(url))
      super(url, options)
    }
  } as typeof Worker

  const { container } = render(<Host />)
  // First paint is synchronous by design — a mount must never show an empty
  // canvas while a worker boots.
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
  globalThis.Worker = RealWorker

  expect(built.filter((url) => url.includes('layout-worker'))).not.toEqual([])
  // A layout of this size blocks for hundreds of ms synchronously, which at
  // 60Hz is tens of frames lost. The bar is deliberately far below what a
  // free thread produces and far above what a blocked one can: measured at 2
  // frames with offloading disabled.
  expect(frames).toBeGreaterThan(5)
}, 40_000)

/**
 * A realm that cannot register the vendored face measures text with a system
 * font, so its scene disagrees with an export of the same canvas — wrong
 * pixels, not a slow frame. The worker refuses instead, and this pins what the
 * editor does with that refusal: renders the canvas correctly anyway, and
 * stops asking. Worker `FontFaceSet` support was verified in Chromium, WebKit
 * and Firefox, but Playwright's WebKit is not Safari, so the refusal path is
 * reachable in the field and cannot go untested.
 */
it('falls back and stays synchronous when the worker cannot load the font', async () => {
  const RealWorker = globalThis.Worker
  let constructed = 0
  class RefusingWorker extends EventTarget {
    constructor() {
      super()
      constructed += 1
    }
    postMessage(request: { id: number }) {
      const response: LayoutResponse = { type: 'failed', id: request.id, reason: FONT_DEGRADED }
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: response })))
    }
    terminate() {}
  }
  globalThis.Worker = RefusingWorker as unknown as typeof Worker

  const { container } = render(<Host />)
  screen.getByTestId('edit').click()

  // The content is right despite the refusal — this is the "costs
  // responsiveness, never content" guarantee.
  await vi.waitFor(() => expect(container.textContent ?? '').toContain('second'))

  screen.getByTestId('edit').click()
  await vi.waitFor(() => expect(container.textContent ?? '').toContain('second'))

  globalThis.Worker = RealWorker
  // Latched after the first refusal: a realm that cannot load the face never
  // will, so re-spawning a worker per edit would be pure waste.
  expect(constructed).toBe(1)
}, 40_000)
