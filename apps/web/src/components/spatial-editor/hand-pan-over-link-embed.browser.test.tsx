/**
 * The dead zone `hand-pan-dead-zone.property.browser.test.tsx` found,
 * pinned as the two examples it shrank to.
 *
 * A link node offers an embed once its on-screen box is large enough, and the
 * affordance is marked `data-editor-overlay` so a press on it reaches its own
 * onClick instead of starting a canvas gesture. That is right for the Select
 * tool and wrong for the hand tool, which is navigation-only: there the press
 * has to pan like any other.
 *
 * On a phone it presents as a region that "sometimes" does not respond —
 * sometimes, because the affordance rides the canvas (so which screen region
 * it covers depends on the pan) and appears only above a zoom threshold.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

// 400x300 at zoom 1 clears the embed LOD thresholds (200x140).
const NODE = { id: 'l1', type: 'link', x: 60, y: 60, width: 400, height: 300 } as const
// A port nothing listens on: the iframe element mounts and refuses at once,
// so the live-embed case never leaves the machine.
const board: SpatialCanvas = {
  nodes: [{ ...NODE, url: 'http://127.0.0.1:1/' }],
  edges: [],
}

function Host({ tool }: { tool: 'hand' | 'select' }) {
  const [canvas, setCanvas] = useState<SpatialCanvas>(board)
  return (
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor
        defaultTool={tool}
        canvas={canvas}
        onChange={(next) => setCanvas(next)}
        theme="light"
      />
    </div>
  )
}

function readTranslate(container: HTMLElement): { x: number; y: number } {
  const css = (container.querySelector('[data-testid="viewport-transform"]') as HTMLElement).style
    .transform
  const m = css.match(/translate\(([-\d.e+]+)px, ([-\d.e+]+)px\)/)
  if (m === null) throw new Error(`unexpected transform: ${css}`)
  return { x: Number(m[1]), y: Number(m[2]) }
}

/**
 * Presses at the given root-local point, on whatever element is really there —
 * which is the whole point, since the defect is an element taking a press.
 *
 * It THROWS rather than falling back to the root when nothing is at the point.
 * The fallback is what a probe that missed its target looks like, and it makes
 * the test pass while never touching the layer it exists to check.
 */
function dragFrom(root: HTMLElement, at: { x: number; y: number }, by: { x: number; y: number }) {
  const rect = root.getBoundingClientRect()
  const clientX = rect.left + at.x
  const clientY = rect.top + at.y
  const target = document.elementFromPoint(clientX, clientY)
  if (target === null) throw new Error(`nothing at (${clientX}, ${clientY}) to press`)
  const init = { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0 }
  fireEvent.pointerDown(target, { ...init, buttons: 1, clientX, clientY })
  fireEvent.pointerMove(root, {
    ...init,
    buttons: 1,
    clientX: clientX + by.x,
    clientY: clientY + by.y,
  })
  fireEvent.pointerUp(root, {
    ...init,
    buttons: 0,
    clientX: clientX + by.x,
    clientY: clientY + by.y,
  })
}

const CENTRE = { x: NODE.x + NODE.width / 2, y: NODE.y + NODE.height / 2 }
// The facade sits on the node's centre, nudged 8px down (see LinkEmbedLayer).
const FACADE = { x: CENTRE.x, y: CENTRE.y + 8 }

/**
 * That the press point is over the embed layer, checked from GEOMETRY.
 *
 * Not from the hit test: once the fix lands the layer stops taking the
 * pointer, so `elementFromPoint` answers with what is beneath it and a
 * hit-test guard would fail on the fixed code. The geometry is the same
 * before and after, and it is what "this probe reached its subject" means.
 */
function expectOver(root: HTMLElement, testId: string, at: { x: number; y: number }) {
  const rect = root.getBoundingClientRect()
  const box = screen.getByTestId(testId).getBoundingClientRect()
  const x = rect.left + at.x
  const y = rect.top + at.y
  expect({
    inside: x >= box.left && x <= box.right && y >= box.top && y <= box.bottom,
    hasArea: box.width > 0 && box.height > 0,
  }).toEqual({ inside: true, hasArea: true })
}

it('hand tool pans from a press on a link node embed facade', async () => {
  const { container } = render(<Host tool="hand" />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  await screen.findByTestId('link-embed-facade')
  expectOver(root, 'link-embed-facade', FACADE)

  const before = readTranslate(container)
  dragFrom(root, FACADE, { x: 40, y: -25 })
  const after = readTranslate(container)

  expect({ dx: after.x - before.x, dy: after.y - before.y }).toEqual({ dx: 40, dy: -25 })
})

it('hand tool pans from a press on a live link embed', async () => {
  const { container } = render(<Host tool="select" />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  await userEvent.click(await screen.findByTestId('link-embed-facade'))
  await screen.findByTestId('link-embed-frame')
  await userEvent.click(screen.getByRole('button', { name: 'Hand (pan)' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Hand (pan)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    ),
  )

  expectOver(root, 'link-embed-frame', CENTRE)

  const before = readTranslate(container)
  dragFrom(root, CENTRE, { x: -30, y: 20 })
  const after = readTranslate(container)

  expect({ dx: after.x - before.x, dy: after.y - before.y }).toEqual({ dx: -30, dy: 20 })
})
