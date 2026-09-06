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

/**
 * The ramp has to survive the canvas re-fitting around what is left.
 *
 * The editor's SVG document IS the scene's bounds — `documentEnvelope` sets
 * `viewBox`, `width` and `height` from `sceneBounds`, and the container is
 * placed at its origin. So a conversation sitting on the OUTER edge takes
 * the envelope with it when it leaves: measured, `40 60 490 170` became
 * `40 150 200 80` on one resolve, putting the departing chrome outside the
 * new viewport and under the UA's default `overflow: hidden`.
 *
 * That clipped the ramp precisely where a comment usually sits — off to the
 * side of everything — while every unit test stayed green, because they
 * assert that the animation EXISTS and not that anything is painted.
 *
 * Letting the surface overflow is sound rather than a patch over it: the
 * viewBox is `sceneBounds`, the union of everything in the scene, so no
 * scene content is ever outside it. A ghost is the only thing that can be.
 */
it('keeps a conversation on the outer edge painting while it ramps, past the re-fitted viewport', async () => {
  const outer: SpatialCanvas = {
    nodes: [{ id: 'n1', type: 'text', x: 40, y: 150, width: 200, height: 80, text: 'The plan' }],
    edges: [],
    'x-whiteboard': { comments: [{ ...COMMENT, x: 300, y: 70, resolved: false }] },
  }
  const view = (resolved: boolean) => (
    <div style={{ width: 520, height: 300 }}>
      <SpatialEditor
        defaultTool="select"
        canvas={{
          ...outer,
          'x-whiteboard': { comments: [{ ...COMMENT, x: 300, y: 70, resolved }] },
        }}
        createId={() => 'id-1'}
        onChange={vi.fn()}
        theme="light"
      />
    </div>
  )
  const { container, rerender } = render(view(false))
  await vi.waitFor(() => expect(pinIn(container)).not.toBeNull(), { timeout: 4000 })
  const root = container.querySelector('[data-testid="canvas-content"] svg')
  if (!(root instanceof SVGSVGElement)) throw new Error('no mounted root')

  rerender(view(true))
  const leaving = pinIn(container)
  if (leaving === null) throw new Error('the pin left without a ramp')

  // The two halves of the claim. The pin really is outside the re-fitted
  // viewport — so this is the clipped case and not a fixture that avoids
  // it — and the surface is set to draw past its viewport anyway.
  const pinBox = leaving.getBoundingClientRect()
  const rootBox = root.getBoundingClientRect()
  expect(pinBox.bottom).toBeLessThanOrEqual(rootBox.top)
  expect(getComputedStyle(root).overflow).toBe('visible')
})
