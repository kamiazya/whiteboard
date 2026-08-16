/**
 * `lostpointercapture` is wired to the same handler as `pointercancel` so a
 * capture the browser REFUSES or revokes cannot strand an in-flight gesture
 * (this component registers no window-level fallback listeners).
 *
 * But that event also fires on the perfectly normal release of a captured
 * pointer, and touch pointers are captured IMPLICITLY by the browser on
 * every pointerdown. So on a touch device it arrives after every tap —
 * including the second tap of a double-tap, which is where the empty-canvas
 * double-press creates a node and opens it for typing. Cancelling there
 * deletes that node (it is `createdForEdit`), so the note appears and
 * vanishes. Mouse input never showed it: capture is taken at the first
 * MOVE, so a stationary double-click holds none to lose.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
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

/** What the browser sends when it hands back an implicitly captured touch. */
function releaseCapture(root: HTMLElement): void {
  root.dispatchEvent(
    new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 1, pointerType: 'touch' }),
  )
}

it('keeps the node a double-press just created when the pointer capture is released', async () => {
  const commands: string[] = []
  const { container } = render(<Host onCommand={(kind) => commands.push(kind)} />)
  const root = rootOf(container)

  await userEvent.dblClick(root, { position: { x: 600, y: 450 } })
  await vi.waitFor(() => expect(container.querySelector('textarea')).not.toBeNull())
  expect(commands.filter((kind) => kind === 'create-node')).toHaveLength(1)

  releaseCapture(root)
  await new Promise((resolve) => setTimeout(resolve, 0))

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

  await userEvent.dblClick(root, { position: { x: 600, y: 450 } })
  await vi.waitFor(() => expect(container.querySelector('textarea')).not.toBeNull())

  root.dispatchEvent(
    new PointerEvent('pointercancel', { bubbles: true, pointerId: 1, pointerType: 'touch' }),
  )
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(commands).toContain('delete-node')
})
