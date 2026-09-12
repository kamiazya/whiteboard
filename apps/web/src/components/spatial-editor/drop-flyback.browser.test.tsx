/**
 * A drop LANDS the node; it never replays the drag.
 *
 * The committed scene is laid out in a worker for any canvas past
 * `use-worker-scene`'s offload threshold, so the drop's own layout arrives one
 * round trip after the commit. Retiring the drag layers at the pointerup hands
 * the surface back to a scene that still draws the node at the grab point, and
 * the keyed patcher then plays its FLIP when the new scene lands — the node
 * teleports back to where the drag began and flies to where it was dropped.
 *
 * Sampled per frame rather than asserted once at the end: both halves are
 * transient, and an end-state assertion passes against the bug.
 */

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

/** Past `use-worker-scene`'s OFFLOAD_MIN_ELEMENTS, so layout is offloaded. */
const NODES = 14

const many = (): SpatialCanvas => ({
  nodes: Array.from({ length: NODES }, (_, i) =>
    textNode({
      id: `n${i}`,
      x: 40 + (i % 4) * 230,
      y: 40 + Math.floor(i / 4) * 150,
      width: 180,
      height: 90,
      text: `node ${i}`,
    }),
  ),
  edges: [],
})

function Host() {
  const [canvas, setCanvas] = useState<SpatialCanvas>(many)
  return (
    <div style={{ width: 1100, height: 800 }}>
      <SpatialEditor defaultTool="select" canvas={canvas} onChange={setCanvas} theme="light" />
    </div>
  )
}

const rootOf = (c: HTMLElement) => c.querySelector('[data-testid="spatial-editor"]') as HTMLElement
const frame = () => new Promise((r) => requestAnimationFrame(r))

it('lands a dropped node where it was released, never back at the grab point', async () => {
  const { container } = render(<Host />)
  const root = rootOf(container)
  // The committed surface's own group for the dragged node — the keyed
  // projection is the only producer of `data-wb-key`, so the drag ghost
  // (plain SVG) can never be mistaken for it.
  const committed = () => container.querySelector('[data-wb-key="n5"]') as SVGGElement | null
  const ghost = () => container.querySelector('[data-testid="drag-preview"]')

  await frame()
  const grabbed = committed()?.getBoundingClientRect()
  expect(grabbed).toBeDefined()
  const startLeft = grabbed?.left ?? 0

  const r = root.getBoundingClientRect()
  const grab = { x: startLeft - r.left + 90, y: (grabbed?.top ?? 0) - r.top + 45 }
  const drop = { x: grab.x + 260, y: grab.y + 190 }
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 3,
    buttons: 1,
    clientX: r.left + grab.x,
    clientY: r.top + grab.y,
  })
  await frame()
  fireEvent.pointerMove(root, {
    pointerId: 3,
    buttons: 1,
    clientX: r.left + drop.x,
    clientY: r.top + drop.y,
  })
  await frame()
  fireEvent.pointerUp(root, { pointerId: 3, clientX: r.left + drop.x, clientY: r.top + drop.y })

  // From the release until the offloaded scene has landed and any animation
  // it might have started has run (the FLIP is 180ms).
  const samples: { left: number | null; animations: number; ghost: boolean }[] = []
  const deadline = performance.now() + 3000
  let landed = 0
  while (performance.now() < deadline && landed < 30) {
    const group = committed()
    samples.push({
      left: group === null ? null : group.getBoundingClientRect().left,
      animations: group?.getAnimations().length ?? 0,
      ghost: ghost() !== null,
    })
    if (group !== null) landed += 1
    await frame()
  }

  const settled = samples.at(-1)
  expect({
    flyBack: samples.filter((s) => s.left !== null && Math.abs(s.left - startLeft) < 1).length,
    animated: samples.filter((s) => s.animations > 0).length,
    // While the committed surface cannot draw the node yet, the ghost is
    // what holds its place — a gap with neither is the node vanishing.
    unheld: samples.filter((s) => s.left === null && !s.ghost).length,
  }).toEqual({ flyBack: 0, animated: 0, unheld: 0 })
  // The control: the drag really did move the node, so the counts above are
  // zero because nothing replayed rather than because nothing happened.
  expect(settled?.left ?? 0).toBeGreaterThan(startLeft + 100)
})

it('settles the ghost on the box the COMMIT produced, not on the last pointermove', async () => {
  // The release computes its own snapped point (`handlePointerUp`), which the
  // last `pointermove` need not agree with — a release that travelled since
  // the last move, or one whose snap modifier changed under it. Holding the
  // pointer's frame parks the node where the drag passed rather than where it
  // was dropped, for as long as the settle lasts.
  const { container } = render(<Host />)
  const root = rootOf(container)
  const committed = () => container.querySelector('[data-wb-key="n5"]') as SVGGElement | null
  const ghost = () => container.querySelector('[data-testid="drag-preview"]')

  await frame()
  const grabbed = committed()?.getBoundingClientRect()
  const r = root.getBoundingClientRect()
  const grab = { x: (grabbed?.left ?? 0) - r.left + 90, y: (grabbed?.top ?? 0) - r.top + 45 }
  const moved = { x: grab.x + 260, y: grab.y + 430 }
  // The release lands somewhere the pointer never reported passing through.
  const released = { x: moved.x + 44, y: moved.y + 37 }

  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 4,
    buttons: 1,
    clientX: r.left + grab.x,
    clientY: r.top + grab.y,
  })
  await frame()
  fireEvent.pointerMove(root, {
    pointerId: 4,
    buttons: 1,
    clientX: r.left + moved.x,
    clientY: r.top + moved.y,
  })
  await frame()
  fireEvent.pointerUp(root, {
    pointerId: 4,
    clientX: r.left + released.x,
    clientY: r.top + released.y,
  })

  // Where the held ghost sat while the committed surface could not draw the
  // node yet, and where the node actually landed.
  const heldAt: number[] = []
  let landedAt: number | null = null
  const deadline = performance.now() + 3000
  while (performance.now() < deadline && landedAt === null) {
    const group = committed()
    if (group !== null) landedAt = group.getBoundingClientRect().left
    else {
      const box = ghost()?.getAttribute('data-box-x')
      if (box !== null && box !== undefined) heldAt.push(Number(box))
    }
    await frame()
  }

  expect(heldAt.length).toBeGreaterThan(0)
  expect(landedAt).not.toBeNull()
  // The ghost's canvas-space x and the landed group's screen x share an
  // origin here (zoom 1, viewport at 0), so they are directly comparable.
  expect([...new Set(heldAt)]).toEqual([landedAt])
})
