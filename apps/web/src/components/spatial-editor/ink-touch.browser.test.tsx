// A drawn stroke under a finger. Freehand ink stores the path the hand took
// as the line's `bends` — tens of them on an ordinary loop — so the bend
// editing a ruled connector line offers turned a selected drawing into a
// fence of grab points: a finger pressing the stroke anywhere grabbed one
// and pulled a spike out of the drawing instead of moving it.

import type { CanvasLine, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { freehandLine } from '../../lib/spatial/freehand.js'
import { tick } from '../../test-utils/async.js'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { touch } from '../../test-utils/spatial-editor-pointer.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const CENTRE = { x: 400, y: 300 }
const RADIUS = 150
const SAMPLES = 72

/** A loop drawn around the centre, sampled the way a pointer would emit it. */
const loopSamples = Array.from({ length: SAMPLES }, (_, i) => {
  const angle = (i / SAMPLES) * Math.PI * 1.8
  return {
    x: Math.round(CENTRE.x + RADIUS * Math.cos(angle)),
    y: Math.round(CENTRE.y + RADIUS * Math.sin(angle)),
  }
})

const drawing = freehandLine('ink1', loopSamples, 1) as CanvasLine

const board: SpatialCanvas = { nodes: [], edges: [], lines: [drawing] }

/** A point ON the stroke that the stored path keeps as a bend. */
const onStroke = drawing.bends?.[Math.floor((drawing.bends?.length ?? 0) / 2)] as {
  x: number
  y: number
}

async function tapOn(root: HTMLElement, at: { x: number; y: number }) {
  touch(root, 'pointerdown', at.x, at.y)
  await tick()
  touch(root, 'pointerup', at.x, at.y)
  await tick()
}

/**
 * Pressed on whatever is under the finger — a handle drawn over the stroke
 * takes the press exactly as it would from a real touch — and moved and
 * released on the root, which holds capture for every gesture.
 */
async function fingerDrag(
  root: HTMLElement,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  const r = root.getBoundingClientRect()
  const under = document.elementFromPoint(r.left + from.x, r.top + from.y) as Element
  under.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      clientX: r.left + from.x,
      clientY: r.top + from.y,
      pointerId: 7,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      buttons: 1,
    }),
  )
  await tick()
  touch(root, 'pointermove', (from.x + to.x) / 2, (from.y + to.y) / 2)
  await tick()
  touch(root, 'pointermove', to.x, to.y)
  await tick()
  touch(root, 'pointerup', to.x, to.y)
  await tick()
}

const shifted = (p: { x: number; y: number }, dx: number, dy: number) => ({
  x: p.x + dx,
  y: p.y + dy,
})

it('a finger dragging a selected drawing moves all of it', async () => {
  expect(drawing.bends?.length ?? 0).toBeGreaterThan(10)
  const { Host, latest } = makeEditorHost({ initial: board })
  const { container } = render(<Host />)
  const root = rootOf(container)

  await tapOn(root, onStroke)
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="edge-selection-highlight"]')).not.toBeNull(),
  )

  await fingerDrag(root, onStroke, shifted(onStroke, 40, 30))

  await vi.waitFor(() =>
    expect(latest.canvas.lines?.[0]?.bends).toEqual(
      drawing.bends?.map((bend) => shifted(bend, 40, 30)),
    ),
  )
  const moved = latest.canvas.lines?.[0]
  expect(moved?.from).toMatchObject({ point: shifted(loopSamples[0] as never, 40, 30) })
  expect(latest.kinds).not.toContain('set-line-bends')
})

it('a selected drawing offers its two ends and none of its points', async () => {
  const { Host } = makeEditorHost({ initial: board })
  const { container } = render(<Host />)

  await tapOn(rootOf(container), onStroke)
  await vi.waitFor(() =>
    expect(container.querySelectorAll('[data-testid^="edge-end-handle-"]')).toHaveLength(2),
  )
  expect(container.querySelectorAll('[data-testid="edge-bend-handle"]')).toHaveLength(0)
  expect(container.querySelectorAll('[data-testid="edge-bend-ghost"]')).toHaveLength(0)
})

it('a ruled line keeps the bend it was given', async () => {
  // The conservative half: a line nobody drew freehand is a connector whose
  // bend somebody placed on purpose, and reshaping it stays one press away.
  const ruled: CanvasLine = {
    id: 'ruled',
    from: { kind: 'point', point: { x: 100, y: 100 } },
    to: { kind: 'point', point: { x: 500, y: 100 } },
    bends: [{ x: 300, y: 250 }],
  }
  const { Host } = makeEditorHost({ initial: { nodes: [], edges: [], lines: [ruled] } })
  const { container } = render(<Host />)

  await tapOn(rootOf(container), { x: 200, y: 175 })
  await vi.waitFor(() =>
    expect(container.querySelectorAll('[data-testid="edge-bend-handle"]')).toHaveLength(1),
  )
})

it('a finger gets a 44px target for each end of a selected line', async () => {
  const realMatchMedia = window.matchMedia
  window.matchMedia = (query: string) =>
    query === '(pointer: coarse)'
      ? ({ matches: true, media: query } as MediaQueryList)
      : realMatchMedia.call(window, query)
  try {
    const { Host } = makeEditorHost({ initial: board })
    const { container } = render(<Host />)
    await tapOn(rootOf(container), onStroke)
    await vi.waitFor(() =>
      expect(container.querySelectorAll('[data-testid^="edge-end-hit-"]')).toHaveLength(2),
    )
    for (const hit of container.querySelectorAll('[data-testid^="edge-end-hit-"]')) {
      const box = hit.getBoundingClientRect()
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44)
    }
  } finally {
    window.matchMedia = realMatchMedia
  }
})
