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
import { resolveInkGroup } from '@kamiazya/whiteboard-plugin-visual'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { STROKE_GROUP_PAUSE_MS } from '../../lib/spatial/stroke-group.js'
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

it('colours the whole mark from the ink menu', async () => {
  // `canvasLineSchema` has carried `color` since the split, and the menu
  // offered the swatch row for a node and an edge only — so every stroke was
  // drawn in the theme's ink whatever the document stored, and a person who
  // wanted a red circle round something could not have one.
  //
  // The whole MARK, not the stroke pressed: a handwritten character is
  // several strokes, and the other verbs on this menu already act on all of
  // them. Recolouring one at a time is a character in two colours.
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)

  drawStroke(root, [
    [120, 400],
    [240, 180],
  ])
  drawStroke(root, [
    [250, 190],
    [380, 420],
  ])
  await expect.poll(() => latest.canvas.lines?.length ?? 0).toBe(2)
  await userEvent.click(page.getByTestId('select-tool-button').element() as HTMLElement)

  const line = latest.canvas.lines?.[0]
  const first = line?.from.kind === 'point' ? line.from.point : { x: 0, y: 0 }
  const last = line?.to.kind === 'point' ? line.to.point : { x: 0, y: 0 }
  const on = { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 }
  const rect = root.getBoundingClientRect()
  root.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      clientX: rect.left + on.x,
      clientY: rect.top + on.y,
    }),
  )

  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  await userEvent.click(await page.getByRole('menuitemradio', { name: 'Red' }).element())

  // The stored value is the semantic slot, never a resolved hex: the theme
  // decides what '1' paints as.
  await expect.poll(() => latest.canvas.lines?.map((entry) => entry.color)).toEqual(['1', '1'])
})

it('joins strokes written one after another into one mark', async () => {
  // A handwritten character is several strokes and a person means one thing
  // by them. Consecutive strokes near each other carry the same group, so
  // everything downstream — selection, Delete — treats them as one.
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)

  drawStroke(root, [
    [200, 200],
    [260, 260],
  ])
  drawStroke(root, [
    [260, 200],
    [200, 260],
  ])
  await expect.poll(() => latest.canvas.lines?.length ?? 0).toBe(2)

  const groups = (latest.canvas.lines ?? []).map((line) => resolveInkGroup(line))
  expect(groups[0]).toBeDefined()
  expect(groups[1]).toBe(groups[0])
})

it('selects and deletes the whole mark from a press on one of its strokes', async () => {
  // The point of grouping. A cross is two strokes; pressing either selects
  // both, and Delete takes the mark rather than half of it.
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)

  drawStroke(root, [
    [200, 200],
    [260, 260],
  ])
  drawStroke(root, [
    [260, 200],
    [200, 260],
  ])
  // A third stroke, far away and after the pause, is its own mark — and the
  // control that says the selection is a GROUP rather than everything.
  await new Promise((resolve) => setTimeout(resolve, STROKE_GROUP_PAUSE_MS + 50))
  drawStroke(root, [
    [600, 450],
    [660, 500],
  ])
  await expect.poll(() => latest.canvas.lines?.length ?? 0).toBe(3)

  await userEvent.click(page.getByTestId('select-tool-button').element() as HTMLElement)
  const first = latest.canvas.lines?.[0]
  const start = first?.from.kind === 'point' ? first.from.point : { x: 0, y: 0 }
  const bend = first?.bends?.[0] ?? { x: 0, y: 0 }
  await userEvent.click(root, {
    position: { x: (start.x + bend.x) / 2, y: (start.y + bend.y) / 2 },
  })
  await expect.element(page.getByTestId('edge-selection-highlight')).toBeInTheDocument()

  await userEvent.keyboard('{Delete}')
  await expect.poll(() => latest.canvas.lines?.length ?? 0).toBe(1)
})

it('breaks a mark apart from the menu, when the guess was wrong', async () => {
  // Strokes are joined automatically, so there has to be a way to say the
  // guess was wrong. After Ungroup each stroke stands alone: a press selects
  // one, and Delete takes one.
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)

  drawStroke(root, [
    [200, 200],
    [260, 260],
  ])
  drawStroke(root, [
    [260, 200],
    [200, 260],
  ])
  await expect.poll(() => latest.canvas.lines?.length ?? 0).toBe(2)
  await userEvent.click(page.getByTestId('select-tool-button').element() as HTMLElement)

  const first = latest.canvas.lines?.[0]
  const start = first?.from.kind === 'point' ? first.from.point : { x: 0, y: 0 }
  const bend = first?.bends?.[0] ?? { x: 0, y: 0 }
  const on = { x: (start.x + bend.x) / 2, y: (start.y + bend.y) / 2 }
  const rect = root.getBoundingClientRect()
  root.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      clientX: rect.left + on.x,
      clientY: rect.top + on.y,
    }),
  )
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  await userEvent.click(await page.getByRole('menuitem', { name: 'Ungroup' }).element())

  await expect
    .poll(() => (latest.canvas.lines ?? []).filter((l) => resolveInkGroup(l) !== undefined).length)
    .toBe(0)

  // And the mark really is apart: pressing one stroke now deletes only it.
  await userEvent.click(root, { position: on })
  await expect.element(page.getByTestId('edge-selection-highlight')).toBeInTheDocument()
  await userEvent.keyboard('{Delete}')
  await expect.poll(() => latest.canvas.lines?.length ?? 0).toBe(1)
})

it('shift-clicking ink adds it to a selection instead of replacing it', async () => {
  // Multi-select and ink did not compose. Shift-click tests `hitId`, which
  // ink deliberately leaves undefined so the stroke wins the press — so the
  // shift branch never ran for ink, and the press fell through to the one
  // that COLLAPSES the node extras and REPLACES the ink selection. Holding
  // shift therefore destroyed the selection it was meant to grow.
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)

  drawStroke(root, [
    [150, 150],
    [220, 220],
  ])
  await new Promise((resolve) => setTimeout(resolve, STROKE_GROUP_PAUSE_MS + 50))
  drawStroke(root, [
    [600, 420],
    [670, 490],
  ])
  await expect.poll(() => latest.canvas.lines?.length ?? 0).toBe(2)
  await expect.poll(() => root.querySelectorAll('path[d*="Q"]').length).toBeGreaterThanOrEqual(2)

  await userEvent.click(page.getByTestId('select-tool-button').element() as HTMLElement)
  const midOf = (index: number) => {
    const line = latest.canvas.lines?.[index]
    const start = line?.from.kind === 'point' ? line.from.point : { x: 0, y: 0 }
    const bend = line?.bends?.[0] ?? { x: 0, y: 0 }
    return { x: (start.x + bend.x) / 2, y: (start.y + bend.y) / 2 }
  }
  await userEvent.click(root, { position: midOf(0) })
  await expect.element(page.getByTestId('edge-selection-highlight')).toBeInTheDocument()
  await userEvent.click(root, { position: midOf(1), modifiers: ['Shift'] })

  // Both marks are held, so one Delete takes both.
  await userEvent.keyboard('{Delete}')
  await expect.poll(() => latest.canvas.lines?.length ?? 0).toBe(0)
})

it('holds a note and a stroke together, and one Delete takes both', async () => {
  // The mixed selection a band already produced, reached the other way —
  // by shift-click. Worth its own case because the two halves live in
  // different state (`selectionState` for nodes, `selectedInkIds` for ink)
  // and only Delete puts them back together.
  const { Host, latest } = makeHost({
    nodes: [textNode({ id: 'a', x: 500, y: 120, width: 160, height: 90, text: 'note' })],
    edges: [],
  })
  const { container } = render(<Host />)
  const root = rootOf(container)

  drawStroke(root, [
    [120, 380],
    [220, 470],
  ])
  await expect.poll(() => latest.canvas.lines?.length ?? 0).toBe(1)
  await expect.poll(() => root.querySelectorAll('path[d*="Q"]').length).toBeGreaterThanOrEqual(1)
  await userEvent.click(page.getByTestId('select-tool-button').element() as HTMLElement)

  const line = latest.canvas.lines?.[0]
  const start = line?.from.kind === 'point' ? line.from.point : { x: 0, y: 0 }
  const bend = line?.bends?.[0] ?? { x: 0, y: 0 }
  await userEvent.click(root, {
    position: { x: (start.x + bend.x) / 2, y: (start.y + bend.y) / 2 },
  })
  await expect.element(page.getByTestId('edge-selection-highlight')).toBeInTheDocument()
  // Shift onto the note: the ink must survive the press that adds it.
  await userEvent.click(root, { position: { x: 580, y: 165 }, modifiers: ['Shift'] })

  // The ink must still be held after the press that added the note — this
  // is the assertion that says the two halves compose, rather than the
  // Delete below passing because one of them was silently dropped.
  expect(
    container.querySelectorAll('[data-testid="edge-selection-highlight"]').length,
  ).toBeGreaterThan(0)

  await userEvent.keyboard('{Delete}')
  await expect.poll(() => latest.canvas.lines?.length ?? 0).toBe(0)
  await expect.poll(() => latest.canvas.nodes.length).toBe(0)
})
