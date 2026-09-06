/**
 * Resolving a conversation on the canvas is a move, not a disappearance —
 * end to end, through the real editor.
 *
 * The patcher's own tests pin the ramp against a hand-built scene. What
 * only this layer can say is that a RESOLVE reaches it: the pin leaves
 * because `layoutSpatialCanvas` stops composing it, several links down from
 * the press, and a mark that never travels that far would leave every one
 * of those tests green over a canvas that still cuts.
 */
import type { CanvasComment, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const COMMENT: CanvasComment = { id: 'thread-1', x: 420, y: 120, text: 'is Friday still right?' }

function canvasWith(resolved: boolean): SpatialCanvas {
  return {
    nodes: [{ id: 'n1', type: 'text', x: 40, y: 40, width: 200, height: 90, text: 'The plan' }],
    edges: [],
    'x-whiteboard': { comments: [{ ...COMMENT, resolved }] },
  }
}

function mount(resolved: boolean) {
  return render(
    <div style={{ width: 700, height: 400 }}>
      <SpatialEditor
        defaultTool="select"
        canvas={canvasWith(resolved)}
        createId={() => 'id-1'}
        onChange={vi.fn()}
        theme="light"
      />
    </div>,
  )
}

const pinIn = (container: HTMLElement) =>
  container.querySelector('[data-testid="canvas-content"] [data-wb-key="thread-1/pin"]')

it('holds the pin on screen ramping out when a conversation resolves, then lets it go', async () => {
  const { container, rerender } = mount(false)
  await vi.waitFor(() => expect(pinIn(container)).not.toBeNull(), { timeout: 4000 })

  rerender(
    <div style={{ width: 700, height: 400 }}>
      <SpatialEditor
        defaultTool="select"
        canvas={canvasWith(true)}
        createId={() => 'id-1'}
        onChange={vi.fn()}
        theme="light"
      />
    </div>,
  )

  // With the default `showResolved` the conversation leaves the scene
  // entirely — and it is still drawn, ramping, rather than gone between two
  // frames.
  const leaving = pinIn(container)
  expect(leaving).not.toBeNull()
  expect(leaving?.getAnimations() ?? []).toHaveLength(1)

  // And it converges: nothing is left behind for the next edit to patch
  // around.
  await vi.waitFor(() => expect(pinIn(container)).toBeNull(), { timeout: 4000 })
})
