/**
 * Mobile navigation contract: with `touch-action: none` on the editor root
 * the browser's own touch scrolling/zooming is disabled, so WE must supply
 * it — two fingers pan and pinch-zoom the viewport (one finger keeps the
 * select/move/marquee semantics). Real PointerEvents with
 * pointerType='touch' exercise the actual root handlers.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

function Host() {
  const [canvas, setCanvas] = useState<SpatialCanvas>({
    nodes: [{ id: 'n1', type: 'text', x: 100, y: 100, width: 200, height: 100, text: 'hello' }],
    edges: [],
  })
  return (
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor canvas={canvas} onChange={(next) => setCanvas(next)} theme="light" />
    </div>
  )
}

function touch(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  pointerId: number,
  x: number,
  y: number,
) {
  const init = {
    pointerId,
    pointerType: 'touch',
    clientX: x,
    clientY: y,
    isPrimary: pointerId === 1,
  }
  if (type === 'pointerdown') fireEvent.pointerDown(target, init)
  else if (type === 'pointermove') fireEvent.pointerMove(target, init)
  else fireEvent.pointerUp(target, init)
}

function getTransform(container: HTMLElement): string {
  const layer = container.querySelector('[data-testid="viewport-transform"]') as HTMLElement
  return layer.style.transform
}

function parseTransform(css: string): { zoom: number; x: number; y: number } {
  const m = css.match(/scale\(([-\d.]+)\) translate\(([-\d.]+)px, ([-\d.]+)px\)/)
  if (!m) throw new Error(`unexpected transform: ${css}`)
  return { zoom: Number(m[1]), x: -Number(m[2]), y: -Number(m[3]) }
}

it('two-finger drag pans the viewport', async () => {
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  const before = parseTransform(getTransform(container))

  touch(root, 'pointerdown', 1, 300, 300)
  touch(root, 'pointerdown', 2, 400, 300)
  touch(root, 'pointermove', 1, 340, 330)
  touch(root, 'pointermove', 2, 440, 330)
  touch(root, 'pointerup', 1, 340, 330)
  touch(root, 'pointerup', 2, 440, 330)

  const after = parseTransform(getTransform(container))
  // Fingers moved +40/+30 screen px; content follows, so the viewport
  // origin moves the opposite way in canvas units.
  expect(after.x).toBeCloseTo(before.x - 40 / before.zoom, 4)
  expect(after.y).toBeCloseTo(before.y - 30 / before.zoom, 4)
  expect(after.zoom).toBeCloseTo(before.zoom, 4)
})

it('spreading two fingers zooms the viewport in', async () => {
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  const before = parseTransform(getTransform(container))

  touch(root, 'pointerdown', 1, 350, 300)
  touch(root, 'pointerdown', 2, 450, 300)
  touch(root, 'pointermove', 1, 300, 300)
  touch(root, 'pointermove', 2, 500, 300)
  touch(root, 'pointerup', 1, 300, 300)
  touch(root, 'pointerup', 2, 500, 300)

  const after = parseTransform(getTransform(container))
  expect(after.zoom).toBeCloseTo(before.zoom * 2, 4)
})

it('a second finger cancels an in-flight one-finger marquee instead of leaving it armed', async () => {
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement

  // One finger down on empty space arms a marquee; the second finger must
  // convert the gesture to pan/zoom, and releasing must leave no marquee.
  touch(root, 'pointerdown', 1, 500, 400)
  touch(root, 'pointerdown', 2, 600, 400)
  touch(root, 'pointermove', 1, 520, 420)
  touch(root, 'pointermove', 2, 620, 420)
  touch(root, 'pointerup', 1, 520, 420)
  touch(root, 'pointerup', 2, 620, 420)

  expect(container.querySelector('[data-testid="marquee-rect"]')).toBeNull()
})

it('activating a pinch captures BOTH fingers, not just the second', async () => {
  // An uncaptured first finger crossing outside the root stops delivering
  // its move/up events, leaving a stale touch entry that would misread a
  // later one-finger press as a pinch participant.
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  const captured: number[] = []
  root.setPointerCapture = (id: number) => {
    captured.push(id)
  }

  touch(root, 'pointerdown', 1, 300, 300)
  touch(root, 'pointerdown', 2, 400, 300)
  touch(root, 'pointerup', 1, 300, 300)
  touch(root, 'pointerup', 2, 400, 300)

  expect(captured).toContain(1)
  expect(captured).toContain(2)
})

it('after a pinch ends, the remaining finger does not keep panning the viewport', async () => {
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement

  touch(root, 'pointerdown', 1, 300, 300)
  touch(root, 'pointerdown', 2, 400, 300)
  touch(root, 'pointermove', 1, 320, 300)
  touch(root, 'pointermove', 2, 420, 300)
  touch(root, 'pointerup', 2, 420, 300)
  const atPinchEnd = getTransform(container)

  // Lone finger keeps moving — must not pan (nor start a marquee drag).
  touch(root, 'pointermove', 1, 420, 400)
  touch(root, 'pointerup', 1, 420, 400)

  expect(getTransform(container)).toBe(atPinchEnd)
})
