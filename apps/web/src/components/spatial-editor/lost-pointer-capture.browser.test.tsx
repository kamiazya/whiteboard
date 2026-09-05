/**
 * `lostpointercapture` cancels the in-flight gesture ONLY while a pointer is
 * still active — a capture the browser refuses or revokes mid-gesture must
 * not strand the editor, which registers no window-level fallback listeners.
 *
 * The guard is what these tests hold in place. That event also fires on the
 * perfectly normal release of a captured pointer, and touch pointers are
 * captured IMPLICITLY by the browser on every pointerdown, so on a touch
 * device it arrives after every tap — including the second tap of a
 * double-tap, which is where the empty-canvas double-press creates a node
 * and opens it for typing. Cancelling there deletes that node (it is
 * `createdForEdit`), so the note appears and vanishes. Mouse input never
 * showed it: capture is taken at the first MOVE, so a stationary
 * double-click holds none to lose.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { rootOf } from '../../test-utils/spatial-editor-root.js'
import { nodeEditorContent } from './node-editor-test-utils.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const start: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 100, y: 100, width: 200, height: 100, text: 'hello world' }],
  edges: [],
}

function Host({ onCommand }: { onCommand?: (kind: string) => void }) {
  const [canvas, setCanvas] = useState<SpatialCanvas>(start)
  return (
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor
        defaultTool="select"
        canvas={canvas}
        onChange={(next, command) => {
          onCommand?.(command.kind)
          setCanvas(next)
        }}
        theme="light"
      />
    </div>
  )
}

/**
 * One tap, as a touch device delivers it — including the capture handback.
 * The browser captures a touch pointer implicitly at `pointerdown` and gives
 * it back right after `pointerup`, so `lostpointercapture` belongs in every
 * tap, not only in the failure case. Driving it here is what keeps this a
 * test of the TOUCH path rather than of the handler in isolation.
 */
function touchTap(root: HTMLElement, x: number, y: number, pointerId = 1): void {
  const rect = root.getBoundingClientRect()
  const init = {
    bubbles: true,
    pointerId,
    pointerType: 'touch',
    isPrimary: true,
    clientX: rect.left + x,
    clientY: rect.top + y,
  }
  root.dispatchEvent(new PointerEvent('pointerdown', { ...init, button: 0 }))
  root.dispatchEvent(new PointerEvent('pointerup', init))
  root.dispatchEvent(new PointerEvent('lostpointercapture', init))
}

it('keeps the node a double-TAP just created when the touch capture is handed back', async () => {
  const commands: string[] = []
  const { container } = render(<Host onCommand={(kind) => commands.push(kind)} />)
  const root = rootOf(container)

  touchTap(root, 600, 450)
  await new Promise((resolve) => setTimeout(resolve, 30))
  touchTap(root, 600, 450)
  await vi.waitFor(() => expect(nodeEditorContent(container)).not.toBeNull())

  expect(commands.filter((kind) => kind === 'create-node')).toHaveLength(1)
  expect(commands).not.toContain('delete-node')
  expect(nodeEditorContent(container)).not.toBeNull()
})

it('recovers a capture lost while its own finger is still down, mid-pinch', async () => {
  // The guard has to be per-pointer, not "is any pointer active". A pinch
  // captures both fingers; lifting one leaves the other down. If the lifted
  // finger's ordinary handback is allowed to stand in for the whole
  // interaction, the pinch bookkeeping is left holding the finger that is
  // STILL down, and the next touch to inherit its id is silently deadened —
  // no selection, no double-tap, nothing.
  const commands: string[] = []
  const { container } = render(<Host onCommand={(kind) => commands.push(kind)} />)
  const root = rootOf(container)
  const rect = root.getBoundingClientRect()
  const p = (type: string, id: number, x: number, y: number) =>
    new PointerEvent(type, {
      bubbles: true,
      pointerId: id,
      pointerType: 'touch',
      isPrimary: id === 1,
      button: 0,
      clientX: rect.left + x,
      clientY: rect.top + y,
    })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

  root.dispatchEvent(p('pointerdown', 1, 300, 300))
  await settle()
  root.dispatchEvent(p('pointerdown', 2, 500, 300))
  await settle()
  root.dispatchEvent(p('pointermove', 1, 290, 300))
  await settle()

  // Finger 1 lifts normally; its capture comes back with it.
  root.dispatchEvent(p('pointerup', 1, 290, 300))
  await settle()
  root.dispatchEvent(p('lostpointercapture', 1, 290, 300))
  await settle()
  // Finger 2's capture is genuinely lost while finger 2 is still down.
  root.dispatchEvent(p('lostpointercapture', 2, 500, 300))
  await settle()

  // The editor must be usable again: a double-tap reusing id 2 creates a node.
  for (let i = 0; i < 2; i++) {
    touchTap(root, 620, 460, 2)
    await settle()
  }

  expect(commands).toContain('create-node')
  expect(nodeEditorContent(container)).not.toBeNull()
})

it('recovers a capture lost mid-resize, which never went through the root press', async () => {
  // Resize/connect presses start on the overlay and bypass handlePointerDown
  // entirely, so a down-set fed only from that handler would not know their
  // pointer exists — and the recovery this guard performs would be skipped
  // for exactly the gestures that hold a node hostage.
  const commands: string[] = []
  const { container } = render(<Host onCommand={(kind) => commands.push(kind)} />)
  const root = rootOf(container)

  touchTap(root, 200, 150)
  const handle = await vi.waitFor(() => {
    const el = container.querySelector('[data-testid^="resize-handle-"]')
    expect(el).not.toBeNull()
    return el as HTMLElement
  })

  const hb = handle.getBoundingClientRect()
  const at = (dx: number, dy: number) => ({
    clientX: hb.x + hb.width / 2 + dx,
    clientY: hb.y + hb.height / 2 + dy,
  })
  handle.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, button: 0, ...at(0, 0) }),
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  root.dispatchEvent(
    new PointerEvent('pointermove', { bubbles: true, pointerId: 7, ...at(40, 40) }),
  )
  await new Promise((resolve) => setTimeout(resolve, 20))

  root.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 7 }))
  await new Promise((resolve) => setTimeout(resolve, 20))

  // Cancelled, so the release commits nothing and the node keeps its size.
  root.dispatchEvent(
    new PointerEvent('pointerup', { bubbles: true, pointerId: 7, ...at(120, 120) }),
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(commands).not.toContain('resize-node')
})

it('still discards the new node on a real pointercancel', async () => {
  // The debris rule this must not trade away: a node that exists only to
  // hold an edit has nothing to revert TO, so a genuine cancellation takes
  // the node with it. Only `lostpointercapture` is being reclassified —
  // `pointercancel` still means what it says.
  const commands: string[] = []
  const { container } = render(<Host onCommand={(kind) => commands.push(kind)} />)
  const root = rootOf(container)

  touchTap(root, 600, 450)
  await new Promise((resolve) => setTimeout(resolve, 30))
  touchTap(root, 600, 450)
  await vi.waitFor(() => expect(nodeEditorContent(container)).not.toBeNull())

  root.dispatchEvent(
    new PointerEvent('pointercancel', { bubbles: true, pointerId: 1, pointerType: 'touch' }),
  )
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(commands).toContain('delete-node')
})
