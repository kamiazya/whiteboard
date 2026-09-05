/**
 * Touch long-press -> context menu. iOS Safari never synthesises a
 * `contextmenu` event from a touch long-press (Android Chrome does), so the
 * editor arms its own timer on a single stationary touch. Real browser:
 * the behavior hangs off genuine pointer-event dispatch and hit geometry.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { rootOf } from '../../test-utils/spatial-editor-root.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const withNode: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 100, y: 100, width: 200, height: 60, text: 'hold me' }],
  edges: [],
}

function mount(canvas: SpatialCanvas, tool: 'select' | 'hand' = 'select') {
  const latest: { canvas: SpatialCanvas } = { canvas }
  function Host() {
    const [current, setCurrent] = useState<SpatialCanvas>(canvas)
    latest.canvas = current
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor defaultTool={tool} canvas={current} onChange={setCurrent} theme="light" />
      </div>
    )
  }
  return { latest, ...render(<Host />) }
}

function touch(el: HTMLElement, type: string, x: number, y: number, pointerId = 7) {
  const r = el.getBoundingClientRect()
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: r.left + x,
      clientY: r.top + y,
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: type === 'pointerdown' ? 0 : -1,
      buttons: type === 'pointerup' ? 0 : 1,
    }),
  )
}

it('a stationary touch long-press opens the context menu without dragging the node', async () => {
  const { container, latest } = mount(withNode)
  const root = rootOf(container)
  touch(root, 'pointerdown', 200, 130)
  await new Promise((resolve) => setTimeout(resolve, 650))
  await vi.waitFor(() => {
    expect(container.querySelector('[data-testid="context-menu"]')).not.toBeNull()
  })
  expect(container.textContent).toContain('Delete')
  // The commit moment gives visible feedback at the pressed point — the
  // always-available sibling of the best-effort haptic tick.
  expect(container.querySelector('[data-testid="long-press-pulse"]')).not.toBeNull()
  // The press was a menu invocation, not a drag: lifting afterwards leaves
  // the node exactly where it was.
  touch(root, 'pointerup', 200, 130)
  expect(latest.canvas.nodes[0]).toMatchObject({ x: 100, y: 100 })
})

it('movement past the slop cancels the long-press menu (a drag is a drag)', async () => {
  const { container } = mount(withNode)
  const root = rootOf(container)
  touch(root, 'pointerdown', 200, 130)
  touch(root, 'pointermove', 230, 130)
  await new Promise((resolve) => setTimeout(resolve, 650))
  expect(container.querySelector('[data-testid="context-menu"]')).toBeNull()
  touch(root, 'pointerup', 230, 130)
})

it('lifting before the delay never opens the menu (a tap is a tap)', async () => {
  const { container } = mount(withNode)
  const root = rootOf(container)
  touch(root, 'pointerdown', 200, 130)
  touch(root, 'pointerup', 200, 130)
  await new Promise((resolve) => setTimeout(resolve, 650))
  expect(container.querySelector('[data-testid="context-menu"]')).toBeNull()
})

it('cancels touchstart on the canvas so iOS cannot claim the press, but not on overlays', () => {
  const { container } = mount(withNode)
  const root = rootOf(container)
  // Canvas surface: the native gesture claim (selection loupe, haptic-touch
  // takeover — the thing that fires pointercancel and disarms the menu
  // timer) must be refused at touchstart.
  const onCanvas = new TouchEvent('touchstart', { bubbles: true, cancelable: true })
  root.dispatchEvent(onCanvas)
  expect(onCanvas.defaultPrevented).toBe(true)
  // Overlays hold real form controls and keep native touch semantics.
  const palette = container.querySelector('[data-editor-overlay]') as HTMLElement
  const onOverlay = new TouchEvent('touchstart', { bubbles: true, cancelable: true })
  palette.dispatchEvent(onOverlay)
  expect(onOverlay.defaultPrevented).toBe(false)
})

it('hand mode: a stationary long-press opens the comment verbs, and a finger that moves first keeps panning', async () => {
  const { container, latest } = mount(withNode, 'hand')
  const root = rootOf(container)
  const transform = () =>
    (container.querySelector('[data-testid="viewport-transform"]') as HTMLElement).style.transform

  // Held still past the delay over the node: the annotation verb for it,
  // none of its edit verbs, and the node untouched by the press.
  touch(root, 'pointerdown', 200, 130)
  // Waited on as a condition: the menu is what the delay produces.
  await vi.waitFor(
    () => {
      expect(container.querySelector('[data-testid="context-menu"]')).not.toBeNull()
    },
    { timeout: 2000 },
  )
  expect(container.textContent).toContain('Comment on this')
  expect(container.textContent).not.toContain('Delete')
  touch(root, 'pointerup', 200, 130)
  expect(latest.canvas.nodes[0]).toMatchObject({ x: 100, y: 100 })
  // Closing it: a pointerdown anywhere outside is the menu's own dismissal.
  // The menu takes focus in the same effect that subscribes to that press,
  // so focus is the condition that the press will be heard.
  await vi.waitFor(() =>
    expect(document.activeElement?.closest('[data-testid="context-menu"]')).not.toBeNull(),
  )
  touch(root, 'pointerdown', 700, 500, 8)
  touch(root, 'pointerup', 700, 500, 8)
  await vi.waitFor(() => {
    expect(container.querySelector('[data-testid="context-menu"]')).toBeNull()
  })

  // A pan that starts moving before the delay is a pan: the timer is
  // cleared by the travel and the drag keeps going past the delay.
  const before = transform()
  touch(root, 'pointerdown', 400, 400, 9)
  touch(root, 'pointermove', 440, 440, 9)
  await vi.waitFor(() => expect(transform()).not.toBe(before))
  await new Promise((resolve) => setTimeout(resolve, 650))
  expect(container.querySelector('[data-testid="context-menu"]')).toBeNull()
  const mid = transform()
  touch(root, 'pointermove', 480, 480, 9)
  await vi.waitFor(() => expect(transform()).not.toBe(mid))
  touch(root, 'pointerup', 480, 480, 9)
})
