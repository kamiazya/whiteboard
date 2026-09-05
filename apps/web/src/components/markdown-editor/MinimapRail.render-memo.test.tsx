// MinimapRail rebuilt its geometry from railGeometry(blocks, {...}) on every
// render, even though `blocks` — the expensive-to-derive input — was
// unchanged; only `viewport` (updated per scroll tick) actually needs a
// fresh render. A fresh geometry object every render also defeats
// useCallback(seekTo, [geometry, onSeek]).
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MinimapRail } from './MinimapRail.js'

const railGeometrySpy = vi.fn()

vi.mock('../../lib/rail-geometry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/rail-geometry.js')>()
  return {
    ...actual,
    railGeometry: (...args: Parameters<typeof actual.railGeometry>) => {
      railGeometrySpy(...args)
      return actual.railGeometry(...args)
    },
  }
})

const RAIL_HEIGHT = 200
const blocks = [{ x: 0, y: 0, w: 400, h: 100 }]

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(RAIL_HEIGHT)
  railGeometrySpy.mockClear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('does not recompute geometry on a re-render with the same blocks, only a new viewport object', () => {
  const onSeek = vi.fn()
  const { rerender } = render(
    <MinimapRail blocks={blocks} viewport={{ top: 0, height: 100 }} onSeek={onSeek} />,
  )
  // Mount itself legitimately recomputes geometry once more when the
  // ResizeObserver effect settles railHeight from 0 to its measured value —
  // a real dependency change. That settles synchronously here (render()
  // flushes effects via act), so the baseline is taken AFTER mount rather
  // than assumed to be exactly one call.
  const baseline = railGeometrySpy.mock.calls.length
  expect(baseline).toBeGreaterThanOrEqual(1)

  // Same blocks reference, a brand-new viewport object with the same
  // values as an ordinary scroll-tick update would produce.
  rerender(<MinimapRail blocks={blocks} viewport={{ top: 0, height: 100 }} onSeek={onSeek} />)
  expect(railGeometrySpy).toHaveBeenCalledTimes(baseline)
})
