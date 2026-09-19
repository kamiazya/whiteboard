// Freehand ink in the editor, in a real browser: pick the pen, drag across
// empty board, and the stroke becomes a LINE whose bends are the path the
// hand took.
//
// A stroke is a line rather than an edge, a new element kind or a fourth
// collection (ADR-0038 decision 2, and `canvasLineSchema`'s own note that a
// line is where freehand lands). Pressure is deliberately absent in v1 and
// arrives as a facet on the line when it is wanted, so nothing here has to
// change for it.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const start: SpatialCanvas = { nodes: [], edges: [] }

function makeHost() {
  const latest = { canvas: start }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(start)
    latest.canvas = canvas
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor
          defaultTool="draw"
          canvas={canvas}
          onChange={(next) => setCanvas(next)}
          theme="light"
        />
      </div>
    )
  }
  return { Host, latest }
}

const rootOf = (container: HTMLElement) =>
  container.querySelector('[data-testid="spatial-editor"]') as HTMLElement

function pointerAt(root: HTMLElement) {
  const rect = root.getBoundingClientRect()
  return (x: number, y: number) => ({ clientX: rect.left + x, clientY: rect.top + y })
}

const down = (at: ReturnType<typeof pointerAt>, x: number, y: number) =>
  new PointerEvent('pointerdown', {
    bubbles: true,
    pointerId: 71,
    button: 0,
    isPrimary: true,
    ...at(x, y),
  })
const move = (at: ReturnType<typeof pointerAt>, x: number, y: number) =>
  new PointerEvent('pointermove', { bubbles: true, pointerId: 71, buttons: 1, ...at(x, y) })
const up = (at: ReturnType<typeof pointerAt>, x: number, y: number) =>
  new PointerEvent('pointerup', { bubbles: true, pointerId: 71, ...at(x, y) })

/**
 * Drives one stroke, in root-relative pixels — which are canvas coordinates
 * too, since the editor's viewport is identity at rest.
 *
 * Fired in ONE turn, deliberately, and that is the point of this helper
 * rather than a shortcut: `pointermove` arrives faster than React commits,
 * so a stroke whose samples only reach the gesture through a rendered
 * closure loses all but the first. Measured on a 61-sample wave drawn this
 * way: ONE bend survived, and the ink came back a straight line — which
 * reads exactly like the simplification having been too coarse. Every
 * assertion below about the SHAPE of the stored path is therefore also an
 * assertion that no sample was dropped on the way in.
 */
function drawStroke(root: HTMLElement, path: readonly (readonly [number, number])[]) {
  const at = pointerAt(root)
  const [first, ...rest] = path
  const [fx, fy] = first as readonly [number, number]
  root.dispatchEvent(down(at, fx, fy))
  for (const [x, y] of rest) root.dispatchEvent(move(at, x, y))
  const [lx, ly] = path[path.length - 1] as readonly [number, number]
  root.dispatchEvent(up(at, lx, ly))
}

it('draws the path the pointer took as ink', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  drawStroke(rootOf(container), [
    [120, 400],
    [240, 180],
    [380, 420],
    [520, 200],
  ])

  await expect.poll(() => latest.canvas.lines?.length ?? 0).toBe(1)
  const line = latest.canvas.lines?.[0]
  // Both ends free, and neither wearing an arrowhead: this is ink, not a
  // connector somebody dragged between two things.
  expect(line?.from).toEqual({ kind: 'point', point: { x: 120, y: 400 }, end: 'none' })
  expect(line?.to).toEqual({ kind: 'point', point: { x: 520, y: 200 }, end: 'none' })
  // The turns the hand made are stored, so the renderer draws the stroke
  // rather than routing a path of its own between the two ends.
  expect(line?.bends).toEqual([
    { x: 240, y: 180 },
    { x: 380, y: 420 },
  ])
  // Ink is not a relation and not a box: nothing else was invented.
  expect(latest.canvas.edges).toEqual([])
  expect(latest.canvas.nodes).toEqual([])
})

it('shows the stroke under the pen, and takes the draft away at the release', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  const at = pointerAt(root)

  root.dispatchEvent(down(at, 120, 400))
  root.dispatchEvent(move(at, 240, 180))
  // The draft is a rendered thing, so this waits for the render the samples
  // above do not need.
  await expect.element(page.getByTestId('ink-draft')).toBeInTheDocument()

  root.dispatchEvent(up(at, 380, 420))

  await expect.poll(() => latest.canvas.lines?.length ?? 0).toBe(1)
  // The draft belongs to the gesture, and the gesture is over.
  await expect.poll(() => page.getByTestId('ink-draft').query()).toBeNull()
})

it('leaves the board alone when the pen only taps it', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  drawStroke(rootOf(container), [
    [300, 300],
    [301, 300],
  ])

  await expect.poll(() => latest.canvas.lines?.length ?? 0).toBe(0)
  expect(latest.canvas.nodes).toEqual([])
})
