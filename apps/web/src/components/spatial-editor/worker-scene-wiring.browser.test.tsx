/**
 * The committed scene goes through the layout worker once a canvas is big
 * enough to be worth the round trip. Every other browser test here uses a
 * canvas well under that threshold and therefore exercises the synchronous
 * path — without this one, the wiring would be covered only by the worker's
 * own parity test and never by the editor that uses it.
 *
 * What it pins is the observable consequence of going async: the scene is not
 * there on the first frame, and an edit is reflected a round trip later rather
 * than never.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

/** Comfortably past OFFLOAD_MIN_ELEMENTS so the worker path is the one taken. */
const big = (label: string): SpatialCanvas => ({
  nodes: Array.from({ length: 10 }, (_, i) => ({
    id: `n${i}`,
    type: 'text' as const,
    x: (i % 4) * 240,
    y: Math.floor(i / 4) * 160,
    width: 200,
    height: 120,
    text: i === 0 ? label : `node ${i}`,
  })),
  edges: Array.from({ length: 6 }, (_, i) => ({
    id: `e${i}`,
    fromNode: `n${i}`,
    toNode: `n${(i + 3) % 10}`,
  })),
})

function Host() {
  const [canvas, setCanvas] = useState<SpatialCanvas>(big('first'))
  return (
    <div style={{ width: 900, height: 600 }}>
      <button type="button" data-testid="edit" onClick={() => setCanvas(big('second'))}>
        edit
      </button>
      <SpatialEditor canvas={canvas} onChange={setCanvas} theme="light" />
    </div>
  )
}

it('lays a worker-sized canvas out off the main thread and keeps up with edits', async () => {
  // Observing the Worker CONSTRUCTION is the only honest way to pin which
  // path ran. Asserting "the DOM has not caught up yet" does not: React
  // schedules the synchronous path's re-render too, so that assertion holds
  // either way — verified by making it pass with offloading disabled.
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

  screen.getByTestId('edit').click()

  // The edit arrives through the worker, so it lands on a later frame.
  await vi.waitFor(() => expect(container.textContent ?? '').toContain('second'))
  expect(container.textContent ?? '').not.toContain('first')

  globalThis.Worker = RealWorker
  expect(built.filter((url) => url.includes('layout-worker'))).not.toEqual([])
}, 30_000)
