/**
 * What a stream of input changes costs the layout worker while it is busy.
 *
 * Remote edits publish one canvas each, and a large board's layout takes
 * longer than the gap between them. A worker handed every one lays out every
 * one in turn — each a full layout and a structured clone of the board —
 * while only the newest reply is ever drawn. So the editor keeps one request
 * in flight and holds just the newest input behind it.
 */

import { createFixedMeasure } from '@kamiazya/whiteboard-canvas-render/test-utils'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { LayoutRequest, LayoutResponse } from '../../lib/layout-worker-protocol.js'
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

/** A worker that answers only when the test says so. */
class HoldingWorker {
  static current: HoldingWorker | null = null
  readonly posted: LayoutRequest[] = []
  readonly listeners = new Set<(event: MessageEvent<LayoutResponse>) => void>()
  constructor() {
    HoldingWorker.current = this
  }
  addEventListener(type: string, listener: (event: MessageEvent<LayoutResponse>) => void) {
    if (type === 'message') this.listeners.add(listener)
  }
  removeEventListener(type: string, listener: (event: MessageEvent<LayoutResponse>) => void) {
    if (type === 'message') this.listeners.delete(listener)
  }
  postMessage(message: { type?: unknown }) {
    if (message.type === 'layout') this.posted.push(message as LayoutRequest)
  }
  terminate() {}
  /** Answers the request with `id` as laid out, with an svg naming its marker. */
  reply(request: LayoutRequest) {
    const marker = request.canvas?.nodes[0]?.resource?.content ?? ''
    const response = {
      type: 'laid-out',
      id: request.id,
      svg: `<svg>${marker}</svg>`,
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      scene: { nodes: [] },
      anchors: [],
    } as unknown as LayoutResponse
    for (const listener of [...this.listeners]) {
      listener({ data: response } as MessageEvent<LayoutResponse>)
    }
  }
}

it('posts at most the newest pending input while a layout is in flight', async () => {
  vi.stubGlobal('Worker', HoldingWorker)
  const base = { measure: fakeMeasure, theme: 'light' as const }
  const seams = {}
  const { result, rerender } = renderHook(
    ({ canvas }: { canvas: SpatialCanvas }) => useWorkerScene(canvas, base, seams, undefined),
    { initialProps: { canvas: canvasWith('edit-0') } },
  )
  const changes = 50
  for (let i = 1; i <= changes; i += 1) {
    await act(async () => {
      rerender({ canvas: canvasWith(`edit-${i}`) })
    })
  }
  const worker = HoldingWorker.current
  expect(worker).not.toBeNull()
  if (worker === null) return
  // Every change arrived while the first request was still out.
  expect(worker.posted.length).toBeLessThanOrEqual(2)
  expect(worker.posted.length).toBeGreaterThan(0)

  // Answering the one in flight sends the newest input, and that is the one drawn.
  await act(async () => {
    worker.reply(worker.posted[0] as LayoutRequest)
  })
  const last = worker.posted.at(-1) as LayoutRequest
  expect(last.canvas?.nodes[0]?.resource?.content).toBe(`edit-${changes}`)
  await act(async () => {
    worker.reply(last)
  })
  expect(worker.posted.length).toBeLessThanOrEqual(2)
  expect(result.current.svg).toBe(`<svg>edit-${changes}</svg>`)
  expect(result.current.sceneCurrent).toBe(true)
})
