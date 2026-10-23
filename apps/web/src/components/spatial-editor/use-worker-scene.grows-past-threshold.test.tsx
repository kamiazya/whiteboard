/**
 * A canvas that arrives small and grows past the offload threshold (a
 * document opened empty, then filled by its first sync) must still get its
 * layout requested: the scene on screen was laid out from the EARLIER, smaller
 * inputs, so treating it as the first scene leaves the board drawn empty.
 */

import { createFixedMeasure } from '@kamiazya/whiteboard-canvas-render/test-utils'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { LayoutRequest } from '../../lib/layout-worker-protocol.js'

const warn = vi.hoisted(() => vi.fn())
vi.mock('../../lib/app-logger.js', () => ({
  getAppLogger: () => ({ warn, error() {}, info() {}, debug() {} }),
}))

import { useWorkerScene } from './use-worker-scene.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** The channel's stall window: past a slow cold start, short of leaving a board unlaid-out. */
const STALL_MS = 8000

const fakeMeasure = createFixedMeasure({ advance: 30, ascent: 10, descent: 2 })

const board = (count: number): SpatialCanvas => ({
  nodes: Array.from({ length: count }, (_, i) =>
    textNode({ id: `n${i}`, x: i * 220, y: 0, width: 200, height: 100, text: `node ${i}` }),
  ),
  edges: [],
})

class RecordingWorker {
  static posted: LayoutRequest[] = []
  addEventListener() {}
  removeEventListener() {}
  postMessage(message: { type?: unknown }) {
    if (message.type === 'layout') RecordingWorker.posted.push(message as LayoutRequest)
  }
  terminate() {}
}

it('requests a layout when an empty canvas grows past the offload threshold', async () => {
  RecordingWorker.posted = []
  vi.stubGlobal('Worker', RecordingWorker)
  const base = { measure: fakeMeasure, theme: 'light' as const }
  const seams = {}
  const { result, rerender } = renderHook(
    ({ canvas }: { canvas: SpatialCanvas }) => useWorkerScene(canvas, base, seams, undefined),
    { initialProps: { canvas: board(0) } },
  )
  await act(async () => {
    rerender({ canvas: board(13) })
  })
  expect(RecordingWorker.posted).toHaveLength(1)
  expect(result.current.sceneCurrent).toBe(false)
})

it("posts a silent worker's request again after the stall window", async () => {
  vi.useFakeTimers()
  try {
    RecordingWorker.posted = []
    vi.stubGlobal('Worker', RecordingWorker)
    const base = { measure: fakeMeasure, theme: 'light' as const }
    const seams = {}
    const { rerender } = renderHook(
      ({ canvas }: { canvas: SpatialCanvas }) => useWorkerScene(canvas, base, seams, undefined),
      { initialProps: { canvas: board(13) } },
    )
    await act(async () => {
      rerender({ canvas: board(14) })
    })
    expect(RecordingWorker.posted).toHaveLength(1)
    await act(async () => {
      vi.advanceTimersByTime(STALL_MS - 1)
    })
    expect(RecordingWorker.posted).toHaveLength(1)
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(RecordingWorker.posted).toHaveLength(2)
    expect(warn).toHaveBeenCalledOnce()
    expect(RecordingWorker.posted[1]?.id).not.toBe(RecordingWorker.posted[0]?.id)
  } finally {
    vi.useRealTimers()
  }
})
