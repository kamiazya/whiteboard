/**
 * Hand tool: what happened BEFORE a press must not decide whether it pans.
 *
 * The sibling property (`hand-pan-dead-zone`) generates the viewport and the
 * press point, and remounts for every run — so it can only ever see a defect
 * that depends on WHERE a finger lands. This one holds one editor across a
 * whole sequence of gestures, which is the only way to see a defect that
 * depends on what the last gesture left behind.
 *
 * The invariant is stated so it needs no clock. Hand mode's double press
 * deliberately zooms instead of panning, so a press NEAR the previous one is
 * legitimately not a pan; every probe here therefore starts far enough away
 * that no double press can be claimed, whatever the timing. What is left is
 * unconditional: a one-finger drag from a fresh spot pans by its own delta.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { fc } from '@/test-utils/fast-check'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const ROOT_W = 390
const ROOT_H = 780

const board: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 40, y: 40, width: 200, height: 100, text: 'a' },
    { id: 'b', type: 'text', x: 20, y: 300, width: 200, height: 100, text: 'b' },
  ],
  edges: [],
}

function Host() {
  const [canvas, setCanvas] = useState(board)
  return (
    <div style={{ width: ROOT_W, height: ROOT_H }}>
      <SpatialEditor defaultTool="hand" canvas={canvas} onChange={setCanvas} theme="light" />
    </div>
  )
}

interface Pt {
  readonly x: number
  readonly y: number
}

function ev(
  target: Element,
  kind: 'down' | 'move' | 'up' | 'cancel',
  id: number,
  at: Pt,
  isPrimary: boolean,
) {
  const init = {
    pointerId: id,
    pointerType: 'touch',
    isPrimary,
    button: 0,
    buttons: kind === 'up' || kind === 'cancel' ? 0 : 1,
    clientX: at.x,
    clientY: at.y,
  }
  if (kind === 'down') fireEvent.pointerDown(target, init)
  else if (kind === 'move') fireEvent.pointerMove(target, init)
  else if (kind === 'up') fireEvent.pointerUp(target, init)
  else fireEvent.pointerCancel(target, init)
}

function readViewport(container: HTMLElement) {
  const layer = container.querySelector('[data-testid="viewport-transform"]') as HTMLElement
  const m = layer.style.transform.match(
    /scale\(([-\d.e+]+)\) translate\(([-\d.e+]+)px, ([-\d.e+]+)px\)/,
  )
  if (m === null) throw new Error(`unexpected transform: ${layer.style.transform}`)
  return { zoom: Number(m[1]), x: -Number(m[2]), y: -Number(m[3]) }
}

/**
 * The gestures a finger can leave behind. Each records the last point it
 * PRESSED at, so the probe that follows can stand clear of the double press.
 *
 * `stranded` is the one that needs saying: a finger whose release the root
 * never sees. Real phones produce it — a finger lifted over an element
 * outside the editor, a browser that claims the gesture and cancels it
 * somewhere the handler is not listening. Dispatching the release on
 * `document.body` reproduces it exactly, because the editor's handlers sit on
 * its own root and body is above them.
 */
type Gesture =
  | { readonly kind: 'tap'; readonly at: Pt }
  | { readonly kind: 'drag'; readonly at: Pt; readonly by: Pt }
  | { readonly kind: 'pinch'; readonly a: Pt; readonly b: Pt; readonly by: Pt }
  | { readonly kind: 'stranded'; readonly at: Pt; readonly id: number }
  | { readonly kind: 'cancelled'; readonly at: Pt }

const ptArb = fc.record({
  x: fc.integer({ min: 20, max: ROOT_W - 20 }),
  y: fc.integer({ min: 20, max: ROOT_H - 20 }),
})

const gestureArb: fc.Arbitrary<Gesture> = fc.oneof(
  fc.record({ kind: fc.constant('tap' as const), at: ptArb }),
  fc.record({
    kind: fc.constant('drag' as const),
    at: ptArb,
    by: fc.record({
      x: fc.integer({ min: -40, max: 40 }),
      y: fc.integer({ min: -40, max: 40 }),
    }),
  }),
  fc.record({
    kind: fc.constant('pinch' as const),
    a: ptArb,
    b: ptArb,
    by: fc.record({
      x: fc.integer({ min: -40, max: 40 }),
      y: fc.integer({ min: -40, max: 40 }),
    }),
  }),
  fc.record({
    kind: fc.constant('stranded' as const),
    at: ptArb,
    id: fc.integer({ min: 7, max: 9 }),
  }),
  fc.record({ kind: fc.constant('cancelled' as const), at: ptArb }),
)

/**
 * Two probe spots far apart, so whichever gesture came last there is always
 * one at least 200px from its press — well clear of any double-press slop a
 * reasonable implementation could claim.
 */
const PROBE_A: Pt = { x: 70, y: 180 }
const PROBE_B: Pt = { x: 300, y: 600 }

function farthestFrom(point: Pt): Pt {
  const d = (p: Pt) => Math.hypot(p.x - point.x, p.y - point.y)
  return d(PROBE_A) >= d(PROBE_B) ? PROBE_A : PROBE_B
}

interface Stats {
  probes: number
  afterStranded: number
  afterPinch: number
  afterTouch: number
}

it('a hand drag from a fresh spot pans, whatever gesture came before it', async () => {
  const stats: Stats = { probes: 0, afterStranded: 0, afterPinch: 0, afterTouch: 0 }

  await fc.assert(
    fc.asyncProperty(fc.array(gestureArb, { minLength: 1, maxLength: 5 }), async (gestures) => {
      const { container } = render(<Host />)
      try {
        const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
        const rect = root.getBoundingClientRect()
        const client = (p: Pt): Pt => ({ x: rect.left + p.x, y: rect.top + p.y })

        for (const gesture of gestures) {
          switch (gesture.kind) {
            case 'tap': {
              ev(root, 'down', 1, client(gesture.at), true)
              ev(root, 'up', 1, client(gesture.at), true)
              break
            }
            case 'drag': {
              const from = client(gesture.at)
              const to = { x: from.x + gesture.by.x, y: from.y + gesture.by.y }
              ev(root, 'down', 1, from, true)
              ev(root, 'move', 1, to, true)
              ev(root, 'up', 1, to, true)
              break
            }
            case 'pinch': {
              const a = client(gesture.a)
              const b = client(gesture.b)
              ev(root, 'down', 1, a, true)
              ev(root, 'down', 2, b, false)
              ev(root, 'move', 1, { x: a.x + gesture.by.x, y: a.y + gesture.by.y }, true)
              ev(root, 'up', 1, { x: a.x + gesture.by.x, y: a.y + gesture.by.y }, true)
              ev(root, 'up', 2, b, false)
              break
            }
            case 'stranded': {
              // Down on the canvas, released where the root cannot hear it.
              ev(root, 'down', gesture.id, client(gesture.at), false)
              ev(document.body, 'up', gesture.id, { x: 2, y: 2 }, false)
              break
            }
            case 'cancelled': {
              ev(root, 'down', 1, client(gesture.at), true)
              ev(root, 'cancel', 1, client(gesture.at), true)
              break
            }
          }

          const last = gestures[gestures.length - 1]!
          const lastPoint = gesture.kind === 'pinch' ? gesture.a : (gesture as { at: Pt }).at
          void last
          const probe = farthestFrom(lastPoint)
          const from = client(probe)
          const by = { x: 24, y: -18 }
          const to = { x: from.x + by.x, y: from.y + by.y }

          const before = readViewport(container)
          ev(root, 'down', 1, from, true)
          ev(root, 'move', 1, to, true)
          ev(root, 'up', 1, to, true)
          const after = readViewport(container)

          stats.probes += 1
          stats.afterTouch += 1
          if (gesture.kind === 'stranded') stats.afterStranded += 1
          if (gesture.kind === 'pinch') stats.afterPinch += 1

          expect({
            // Screen pixels: what the invariant means, and the unit the
            // transform is serialised in.
            dx: Math.round((after.x - before.x) * before.zoom * 100) / 100 + 0,
            dy: Math.round((after.y - before.y) * before.zoom * 100) / 100 + 0,
            zoom: after.zoom,
          }).toEqual({ dx: -by.x + 0, dy: -by.y + 0, zoom: before.zoom })
        }
      } finally {
        cleanup()
      }
    }),
    { numRuns: 60 },
  )

  // A sequence generator that never produced the interesting prefixes would
  // pass while checking nothing about gesture history at all.
  expect(stats.probes).toBeGreaterThan(100)
  expect(stats.afterStranded).toBeGreaterThan(5)
  expect(stats.afterPinch).toBeGreaterThan(5)
})
