/**
 * A worker whose MODULE fails to evaluate does not throw at construction —
 * it fires an async `error` event. Nothing about the request path may hang on
 * that: the file's own invariant is "a degraded worker costs responsiveness,
 * never content", and a pending request that never resolves leaves the
 * PREVIOUS scene on screen for every later edit.
 *
 * This is jsdom on purpose: the failure under test is the event wiring, not
 * browser layout, and a stub Worker is the only way to fire the event
 * deterministically. The real-eval-failure case (the
 * decode-named-character-reference alias) is covered by the parity browser
 * test; this covers what the EDITOR does if that class of failure ever ships.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useWorkerScene } from './use-worker-scene.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const fakeMeasure = () => ({ advanceWidth: 30, ascent: 10, descent: 2, lineGap: 0 })

/** Past the offload threshold, no function seams — the worker path engages. */
const canvasWith = (marker: string): SpatialCanvas => ({
  nodes: Array.from({ length: 13 }, (_, i) => ({
    id: `n${i}`,
    type: 'text' as const,
    x: i * 220,
    y: 0,
    width: 200,
    height: 100,
    text: i === 0 ? marker : `node ${i}`,
  })),
  edges: [],
})

class FakeWorker {
  static instances: FakeWorker[] = []
  private listeners = new Map<string, Set<(e: unknown) => void>>()
  constructor() {
    FakeWorker.instances.push(this)
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(fn)
  }
  removeEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.get(type)?.delete(fn)
  }
  postMessage() {}
  terminate() {}
  fire(type: string, event: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(event)
  }
}

it('falls back to a synchronous layout when the worker module fails to evaluate', async () => {
  vi.stubGlobal('Worker', FakeWorker)
  const base = { measure: fakeMeasure, theme: 'light' as const }
  const seams = {}
  const { result, rerender } = renderHook(
    ({ canvas }: { canvas: SpatialCanvas }) => useWorkerScene(canvas, base, seams, undefined),
    { initialProps: { canvas: canvasWith('first-scene') } },
  )
  expect(result.current.svg).toContain('first-scene')

  // The edit whose layout the (dead) worker is asked for.
  await act(async () => {
    rerender({ canvas: canvasWith('second-scene') })
  })
  const worker = FakeWorker.instances.at(-1)
  expect(worker, 'the request should have engaged the worker path').toBeDefined()

  // Module evaluation failing is an async `error` event, never a throw.
  await act(async () => {
    worker?.fire('error', new Event('error'))
  })

  expect(result.current.svg).toContain('second-scene')
})
