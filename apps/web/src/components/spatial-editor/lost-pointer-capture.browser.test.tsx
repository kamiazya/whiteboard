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
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
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

function rootOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
}

/**
 * One tap, as a touch device delivers it — including the capture handback.
 * The browser captures a touch pointer implicitly at `pointerdown` and gives
 * it back right after `pointerup`, so `lostpointercapture` belongs in every
 * tap, not only in the failure case. Driving it here is what keeps this a
 * test of the TOUCH path rather than of the handler in isolation.
 */
function touchTap(root: HTMLElement, x: number, y: number): void {
  const rect = root.getBoundingClientRect()
  const init = {
    bubbles: true,
    pointerId: 1,
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
  await vi.waitFor(() => expect(container.querySelector('textarea')).not.toBeNull())

  expect(commands.filter((kind) => kind === 'create-node')).toHaveLength(1)
  expect(commands).not.toContain('delete-node')
  expect(container.querySelector('textarea')).not.toBeNull()
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
  await vi.waitFor(() => expect(container.querySelector('textarea')).not.toBeNull())

  root.dispatchEvent(
    new PointerEvent('pointercancel', { bubbles: true, pointerId: 1, pointerType: 'touch' }),
  )
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(commands).toContain('delete-node')
})
