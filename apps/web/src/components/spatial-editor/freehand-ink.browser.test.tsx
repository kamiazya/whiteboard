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
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const start: SpatialCanvas = { nodes: [], edges: [] }

function makeHost(from: SpatialCanvas = start) {
  const latest = { canvas: from }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(from)
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

const down = (at: ReturnType<typeof pointerAt>, x: number, y: number, pointerId = 71) =>
  new PointerEvent('pointerdown', {
    bubbles: true,
    pointerId,
    button: 0,
    isPrimary: true,
    ...at(x, y),
  })
const move = (at: ReturnType<typeof pointerAt>, x: number, y: number, pointerId = 71) =>
  new PointerEvent('pointermove', { bubbles: true, pointerId, buttons: 1, ...at(x, y) })
const up = (at: ReturnType<typeof pointerAt>, x: number, y: number, pointerId = 71) =>
  new PointerEvent('pointerup', { bubbles: true, pointerId, ...at(x, y) })

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

it('hands the drawn ink to the select tool, which can then delete it', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)

  // A stroke whose turns are sharp enough that simplification keeps them, so
  // the press below can be aimed at a segment the stored path really has.
  drawStroke(root, [
    [120, 400],
    [240, 180],
    [380, 420],
    [520, 200],
  ])
  await expect.poll(() => latest.canvas.lines?.length ?? 0).toBe(1)

  await userEvent.click(page.getByTestId('select-tool-button').element() as HTMLElement)
  // Midway along the first segment — on the ink, and nowhere near a node.
  await userEvent.click(root, { position: { x: 180, y: 290 } })

  await expect.element(page.getByTestId('edge-selection-highlight')).toBeInTheDocument()

  await userEvent.keyboard('{Delete}')
  await expect.poll(() => latest.canvas.lines?.length ?? 0).toBe(0)
})

it('selects ink drawn ACROSS a note, where the note is what lies under the press', async () => {
  // The case an empty board cannot show, and the one a real board is made of:
  // a scribble goes over what is already there. The press lands inside the
  // note's box AND on the ink, and the ink is what was drawn on top — so the
  // ink is what a press on it selects. Before this the node won at the first
  // branch and the line hit-test never ran, leaving ink over any content
  // unselectable and therefore undeletable except by undo.
  const { Host, latest } = makeHost({
    nodes: [textNode({ id: 'a', x: 250, y: 200, width: 300, height: 200, text: 'note' })],
    edges: [],
  })
  const { container } = render(<Host />)
  const root = rootOf(container)

  drawStroke(root, [
    [150, 300],
    [300, 260],
    [500, 340],
    [650, 300],
  ])
  await expect.poll(() => latest.canvas.lines?.length ?? 0).toBe(1)

  await userEvent.click(page.getByTestId('select-tool-button').element() as HTMLElement)
  // Aimed at the MIDPOINT of a stored segment, not at a bend, and that is
  // load-bearing: ink is drawn as a curve, whose corners leave the polyline
  // at each segment's midpoint and bulge toward the vertex. So a midpoint is
  // exactly ON the drawn path by construction, while the vertex itself is
  // the one place the ink no longer passes through. Measured: aiming at a
  // bend missed the 6px budget and read as the hit-test failing.
  const line = latest.canvas.lines?.[0]
  const drawn = [
    line?.from.kind === 'point' ? line.from.point : undefined,
    ...(line?.bends ?? []),
    line?.to.kind === 'point' ? line.to.point : undefined,
  ].filter((p): p is { x: number; y: number } => p !== undefined)
  const inNote = (p: { x: number; y: number }) => p.x > 250 && p.x < 550 && p.y > 200 && p.y < 400
  const over = drawn
    .slice(0, -1)
    .map((p, i) => {
      const next = drawn[i + 1] as { x: number; y: number }
      return { x: (p.x + next.x) / 2, y: (p.y + next.y) / 2 }
    })
    .find(inNote)
  expect(over).toBeDefined()
  await userEvent.click(root, { position: { x: over?.x ?? 0, y: over?.y ?? 0 } })

  await expect.element(page.getByTestId('edge-selection-highlight')).toBeInTheDocument()
  await userEvent.keyboard('{Delete}')
  await expect.poll(() => latest.canvas.lines?.length ?? 0).toBe(0)
  // The note the ink crossed is still there: deleting ink is not deleting
  // what it was drawn over.
  expect(latest.canvas.nodes).toHaveLength(1)
})

it('rubber-bands over ink and takes only the strokes the band touched', async () => {
  // How a scribble gets erased. Selecting ink one stroke at a time is fine
  // for one line and hopeless for the handful a scribble actually is, and
  // the marquee is the gesture everybody reaches for — it looked at nodes
  // only, so dragging a band over ink selected nothing and Delete removed
  // nothing.
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)

  drawStroke(root, [
    [100, 120],
    [180, 60],
    [260, 140],
  ])
  drawStroke(root, [
    [100, 420],
    [180, 480],
    [260, 400],
  ])
  await expect.poll(() => latest.canvas.lines?.length ?? 0).toBe(2)
  // And wait until the SCENE has them, not merely the canvas. The band reads
  // the laid-out paths, which arrive from the layout worker a beat after the
  // canvas does — a band resolved before that finds nothing and reads
  // exactly like the feature not working. Ink is the only curve on an empty
  // board, so a quadratic in the committed surface is the stroke itself.
  await expect.poll(() => root.querySelectorAll('path[d*="Q"]').length).toBeGreaterThanOrEqual(2)

  await userEvent.click(page.getByTestId('select-tool-button').element() as HTMLElement)
  // A band around the UPPER stroke only.
  //
  // The press ARMS the band in React state and the move reads it back, so
  // the move has to follow a commit. What it waits ON is the band's own
  // `<rect>`, not the `<svg>` that wraps it: an SVG with no width/height
  // measures 300x150 whatever it contains, so a wrapper-sized wait is true
  // the instant the press lands and the release still races the move.
  // Measured: that wait passed immediately and the band resolved as a tap,
  // reading exactly like the band ignoring ink.
  const at = pointerAt(root)
  const bandWidth = () =>
    Number(
      page.getByTestId('marquee-rect').element().querySelector('rect')?.getAttribute('width') ?? 0,
    )
  root.dispatchEvent(down(at, 60, 40, 72))
  await expect.element(page.getByTestId('marquee-rect')).toBeInTheDocument()
  root.dispatchEvent(move(at, 300, 200, 72))
  await expect.poll(bandWidth).toBeGreaterThan(100)
  root.dispatchEvent(up(at, 300, 200, 72))

  await expect.element(page.getByTestId('edge-selection-highlight')).toBeInTheDocument()
  await userEvent.keyboard('{Delete}')

  await expect.poll(() => latest.canvas.lines?.length ?? 0).toBe(1)
  // The one it kept is the LOWER stroke — the band never reached it.
  expect(latest.canvas.lines?.[0]?.from).toEqual({
    kind: 'point',
    point: { x: 100, y: 420 },
    end: 'none',
  })
})

it('offers Delete on the ink itself, for a device with no Delete key', async () => {
  // The keyboard was the only way to remove a stroke: the menu resolved its
  // target out of `canvas.edges`, where a LINE is not, so a press on ink fell
  // through to the empty-canvas menu. A phone has no Delete key, which makes
  // that the whole affordance — ink you can draw and cannot take back.
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)

  drawStroke(root, [
    [120, 400],
    [240, 180],
    [380, 420],
  ])
  await expect.poll(() => latest.canvas.lines?.length ?? 0).toBe(1)
  await userEvent.click(page.getByTestId('select-tool-button').element() as HTMLElement)

  // Right-click ON the stroke: the midpoint of a stored segment, which the
  // drawn curve passes through by construction.
  const line = latest.canvas.lines?.[0]
  const first = line?.from.kind === 'point' ? line.from.point : { x: 0, y: 0 }
  const bend = line?.bends?.[0] ?? { x: 0, y: 0 }
  const on = { x: (first.x + bend.x) / 2, y: (first.y + bend.y) / 2 }
  const rect = root.getBoundingClientRect()
  root.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      clientX: rect.left + on.x,
      clientY: rect.top + on.y,
    }),
  )

  // Waited for the menu itself before reaching into it: `getByRole(...)
  // .element()` resolves synchronously and throws when the menu has not
  // rendered yet, which reads as the verb being absent.
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  await userEvent.click(await page.getByRole('menuitem', { name: 'Delete' }).element())
  await expect.poll(() => latest.canvas.lines?.length ?? 0).toBe(0)
})
