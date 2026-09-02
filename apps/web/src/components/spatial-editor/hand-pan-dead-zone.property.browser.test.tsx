/**
 * Hand tool: every press on the canvas surface pans, wherever it lands and
 * at whatever zoom.
 *
 * Reported from a phone as "some regions sometimes do not respond". Empty
 * space always panned; areas with nodes sometimes did not; it would not
 * reproduce on demand. That is the signature of a dead zone that RIDES the
 * canvas — an interactive overlay positioned in canvas coordinates covers a
 * different screen region at every pan/zoom, so whether a given finger lands
 * on it is decided by the viewport, not by the finger.
 *
 * No example test can be written for it, because nobody knows where the zone
 * is. So the viewport and the press point are generated and the invariant is
 * stated instead: the drag delta reaches the viewport.
 *
 * Chrome (the dock, the overview, the history cluster) legitimately swallows
 * a press, and is excluded by CONSTRUCTION rather than by name: it sits
 * outside the viewport-transform container. Everything INSIDE that container
 * rides the canvas, and hand mode is navigation-only — its tool-change
 * handler already drops every edit affordance — so nothing in there may take
 * a press.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createRef, useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { fc } from '@/test-utils/fast-check'
import { SpatialEditor, type SpatialEditorHandle } from './SpatialEditor.js'
import type { Viewport } from './viewport.js'

afterEach(cleanup)

const ROOT_W = 800
const ROOT_H = 600

/**
 * A board with the density the report describes: overlapping notes, a group,
 * a file node big enough to draw its referenced canvas inline, and link nodes
 * big enough to offer their embed. Every kind of canvas-space layer the
 * editor can put under a finger is represented, because the property's job is
 * to find the one that takes a press — not to check a layer someone already
 * suspected.
 */
const referenced: SpatialCanvas = {
  nodes: [{ id: 'r1', type: 'text', x: 0, y: 0, width: 300, height: 150, text: 'inside' }],
  edges: [],
}

const board: SpatialCanvas = {
  nodes: [
    { id: 'g1', type: 'group', x: 40, y: 40, width: 620, height: 460, label: 'cluster' },
    { id: 't1', type: 'text', x: 80, y: 80, width: 220, height: 120, text: 'one' },
    { id: 't2', type: 'text', x: 260, y: 140, width: 220, height: 120, text: 'two' },
    { id: 't3', type: 'text', x: 120, y: 300, width: 240, height: 140, text: 'three' },
    { id: 'f1', type: 'file', x: 380, y: 300, width: 320, height: 240, file: 'ref-1' },
    {
      id: 'l1',
      type: 'link',
      x: 700,
      y: 60,
      width: 400,
      height: 300,
      url: 'https://example.com/a',
    },
    {
      id: 'l2',
      type: 'link',
      x: 700,
      y: 420,
      width: 400,
      height: 300,
      url: 'https://example.com/b',
    },
    {
      id: 'l3',
      type: 'link',
      x: 60,
      y: 560,
      width: 400,
      height: 300,
      url: 'https://example.com/c',
    },
  ],
  edges: [{ id: 'e1', fromNode: 't1', toNode: 't2' }],
}

function Host({ handle }: { handle: React.RefObject<SpatialEditorHandle | null> }) {
  const [canvas, setCanvas] = useState<SpatialCanvas>(board)
  return (
    <div style={{ width: ROOT_W, height: ROOT_H }}>
      <SpatialEditor
        ref={handle}
        defaultTool="hand"
        canvas={canvas}
        onChange={(next) => setCanvas(next)}
        theme="light"
        fileRefOptions={[{ file: 'ref-1', label: 'Referenced canvas' }]}
        resolveReference={(ref) => (ref === 'ref-1' ? { canvas: referenced } : undefined)}
      />
    </div>
  )
}

function transformLayer(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="viewport-transform"]') as HTMLElement
}

function readViewport(container: HTMLElement): Viewport {
  const css = transformLayer(container).style.transform
  const m = css.match(/scale\(([-\d.e+]+)\) translate\(([-\d.e+]+)px, ([-\d.e+]+)px\)/)
  if (m === null) throw new Error(`unexpected transform: ${css}`)
  return { zoom: Number(m[1]), x: -Number(m[2]), y: -Number(m[3]) }
}

function touch(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  clientX: number,
  clientY: number,
) {
  const init = {
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    clientX,
    clientY,
  }
  if (type === 'pointerdown') fireEvent.pointerDown(target, init)
  else if (type === 'pointermove') fireEvent.pointerMove(target, init)
  else fireEvent.pointerUp(target, init)
}

/** Screen point (root-local) of a canvas point under the given viewport. */
function toRootLocal(point: { x: number; y: number }, vp: Viewport) {
  return { x: (point.x - vp.x) * vp.zoom, y: (point.y - vp.y) * vp.zoom }
}

interface Press {
  readonly nodeIndex: number
  /** Where the chosen node's centre sits on screen; fixes the viewport. */
  readonly screenX: number
  readonly screenY: number
  /** Press offset from that centre, in CANVAS units, so it scales with zoom. */
  readonly ax: number
  readonly ay: number
  readonly dx: number
  readonly dy: number
  readonly zoom: number
}

/**
 * The viewport is derived from the node the press aims at rather than
 * generated independently: an independent one puts the node off screen at
 * most zooms, and the runs that reach anything at all are then too few for
 * the property to mean much (measured: 31 of 120).
 *
 * The offset is a MIXTURE for the same reason. A canvas-space affordance is
 * tens of canvas units across, so a uniform offset over a node-sized box
 * lands on one a few percent of the time and the property passes without
 * ever exercising the thing it exists to check.
 */
const offsetArb = fc.oneof(
  { weight: 2, arbitrary: fc.integer({ min: -16, max: 16 }) },
  { weight: 1, arbitrary: fc.integer({ min: -70, max: 70 }) },
)

const pressArb: fc.Arbitrary<Press> = fc.record({
  nodeIndex: fc.integer({ min: 0, max: board.nodes.length - 1 }),
  screenX: fc.integer({ min: 80, max: ROOT_W - 80 }),
  screenY: fc.integer({ min: 80, max: ROOT_H - 80 }),
  ax: offsetArb,
  ay: offsetArb,
  dx: fc.integer({ min: -70, max: 70 }),
  dy: fc.integer({ min: -70, max: 70 }),
  zoom: fc.integer({ min: 30, max: 400 }).map((n) => n / 100),
})

interface Stats {
  asserted: number
  /** Presses that landed on an interactive overlay riding the canvas. */
  onCanvasSpaceOverlay: number
}

it('a hand-tool press pans from any point on the canvas, at any pan and zoom', async () => {
  const stats: Stats = { asserted: 0, onCanvasSpaceOverlay: 0 }

  await fc.assert(
    fc.asyncProperty(pressArb, async (press) => {
      const handle = createRef<SpatialEditorHandle>()
      const { container } = render(<Host handle={handle} />)
      try {
        const node = board.nodes[press.nodeIndex]!
        const centre = { x: node.x + node.width / 2, y: node.y + node.height / 2 }
        const viewport = {
          zoom: press.zoom,
          x: centre.x - press.screenX / press.zoom,
          y: centre.y - press.screenY / press.zoom,
        }
        await act(async () => {
          handle.current?.setViewport(viewport)
        })
        // Let the level-of-detail effects (canvas embeds, link facades)
        // settle at this zoom before anything is hit-tested.
        await act(async () => {
          await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
        })

        const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
        const rect = root.getBoundingClientRect()
        const before = readViewport(container)

        const local = toRootLocal({ x: centre.x + press.ax, y: centre.y + press.ay }, before)
        // Off-screen at this viewport: nothing to press.
        if (local.x < 2 || local.x > rect.width - 2) return
        if (local.y < 2 || local.y > rect.height - 2) return

        const clientX = rect.left + local.x
        const clientY = rect.top + local.y
        const target = document.elementFromPoint(clientX, clientY)
        if (target === null || !root.contains(target)) return

        const overlay = target.closest('[data-editor-overlay]')
        // Chrome floats ABOVE the canvas rather than riding it; a press on it
        // is a press on a control, and pans nothing by design.
        if (overlay !== null && !transformLayer(container).contains(overlay)) return

        // Counted from GEOMETRY, not from the hit test. Once this defect is
        // fixed the layer stops taking the pointer, so a counter that read
        // `elementFromPoint` would fall to zero on the fixed code and report
        // the generator as too sparse — measured, it did.
        const ridesCanvas = [
          ...transformLayer(container).querySelectorAll<HTMLElement>('[data-editor-overlay]'),
        ].some((el) => {
          const box = el.getBoundingClientRect()
          return (
            box.width > 0 &&
            clientX >= box.left &&
            clientX <= box.right &&
            clientY >= box.top &&
            clientY <= box.bottom
          )
        })
        if (ridesCanvas) stats.onCanvasSpaceOverlay += 1

        touch(target, 'pointerdown', clientX, clientY)
        touch(root, 'pointermove', clientX + press.dx, clientY + press.dy)
        touch(root, 'pointerup', clientX + press.dx, clientY + press.dy)

        const after = readViewport(container)
        stats.asserted += 1
        // Compared in SCREEN pixels, which is both what the invariant means
        // (the content follows the finger) and the unit the transform is
        // serialised in — dividing back into canvas units at zoom 0.3 turns
        // the CSS string's own rounding into a false counterexample.
        expect({
          // `+ 0` normalises -0, which reads as a counterexample against 0.
          dx: Math.round((after.x - before.x) * before.zoom * 100) / 100 + 0,
          dy: Math.round((after.y - before.y) * before.zoom * 100) / 100 + 0,
          zoom: after.zoom,
        }).toEqual({ dx: -press.dx + 0, dy: -press.dy + 0, zoom: before.zoom })
      } finally {
        cleanup()
      }
    }),
    { numRuns: 120 },
  )

  // A property that never reached an overlay riding the canvas would pass
  // whatever those overlays do with a press — the exact blindness this test
  // exists to remove. Floors, not targets: first measured at 106 asserted
  // runs of 120 and 17 of them over a canvas-space affordance; re-measured
  // 2026-09-02 at 8-14 overlay hits across six local runs with a CI run
  // under full parallel load landing at 5 — the old floor of >5 sat inside
  // the real distribution's tail, not below it. The seed is random per run,
  // so the floors sit well below the measurement; a count near them is
  // evidence the board or the generator drifted, not good news.
  expect(stats.asserted).toBeGreaterThan(80)
  expect(stats.onCanvasSpaceOverlay).toBeGreaterThan(2)
})
