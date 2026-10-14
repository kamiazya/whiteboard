/**
 * The seams parameter says only what reaches the worker. Below the offload
 * threshold every option is spread into a synchronous layout; past it, only
 * what the `LayoutRequest` names survives the hop — so an option the request
 * does not carry would draw a small canvas one way and a large one another.
 */

import { createFixedMeasure } from '@kamiazya/whiteboard-canvas-render/test-utils'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, expectTypeOf, it, vi } from 'vitest'
import type { LayoutRequest } from '../../lib/layout-worker-protocol.js'
import { useWorkerScene } from './use-worker-scene.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const fakeMeasure = createFixedMeasure({ advance: 30, ascent: 10, descent: 2 })

const canvasWith = (marker: string): SpatialCanvas => ({
  nodes: Array.from({ length: 13 }, (_, i) =>
    textNode({
      id: `n${i}`,
      x: i * 220,
      y: 0,
      width: 200,
      height: 100,
      text: i === 0 ? marker : `node ${i}`,
    }),
  ),
  edges: [],
})

class RecordingWorker {
  static posted: unknown[] = []
  addEventListener() {}
  removeEventListener() {}
  postMessage(message: unknown) {
    RecordingWorker.posted.push(message)
  }
  terminate() {}
}

it('accepts no seam the worker request cannot carry', () => {
  type Seams = Parameters<typeof useWorkerScene>[2]
  expectTypeOf<Seams>().not.toHaveProperty('commentObstacles')
  expectTypeOf<Seams>().toHaveProperty('style')
})

it('posts the render style with an offloaded layout request', async () => {
  RecordingWorker.posted = []
  vi.stubGlobal('Worker', RecordingWorker)
  const base = { measure: fakeMeasure, theme: 'light' as const }
  const seams = { style: 'clean' as const }
  const { rerender } = renderHook(
    ({ canvas }: { canvas: SpatialCanvas }) => useWorkerScene(canvas, base, seams, undefined),
    { initialProps: { canvas: canvasWith('first-scene') } },
  )
  await act(async () => {
    rerender({ canvas: canvasWith('second-scene') })
  })
  const requests = RecordingWorker.posted.filter(
    (m): m is LayoutRequest => (m as { type?: unknown }).type === 'layout',
  )
  expect(requests.length).toBeGreaterThan(0)
  expect(requests.at(-1)?.style).toBe('clean')
})
