/**
 * Real-browser interaction coverage — pointer capture, drag-to-move, and
 * unmount-mid-gesture are exactly what jsdom cannot exercise faithfully.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { createRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
// Real app styles — needed so the Add-note-button affordance test's
// getComputedStyle assertions reflect the actual shipped CSS, not
// unstyled-DOM defaults.
import '../../index.css'
import type { EditorCommand } from './commands.js'
import { SpatialEditor, type SpatialEditorHandle } from './SpatialEditor.js'

function fakeMeasure() {
  return { advanceWidth: 30, ascent: 10, descent: 2, lineGap: 0 }
}

function twoNodeCanvas(): SpatialCanvas {
  return {
    nodes: [
      { id: 'a', type: 'text', x: 20, y: 20, width: 100, height: 60, text: 'hello' },
      { id: 'b', type: 'file', x: 250, y: 20, width: 80, height: 40, file: 'x.png' },
    ],
    edges: [],
  }
}

/**
 * SpatialEditor is CONTROLLED and owns no state of its own — a real host
 * (canvas-sync-session's synchronous `currentCanvas = next; notify(...)`,
 * see canvas-sync-session.ts) feeds the `onChange` result straight back as
 * the next `canvas` prop. Several create/delete scenarios below depend on
 * that feedback loop (e.g. a newly-created node's own TextNodeEditor only
 * renders once `canvas.nodes` actually contains it), so this thin wrapper
 * reproduces the real host's behavior instead of leaving onChange a
 * feedback-free spy.
 */
function ControlledEditor({
  initial,
  onChange,
  createId,
}: {
  initial: SpatialCanvas
  onChange: (next: SpatialCanvas, command: EditorCommand) => void
  createId?: () => string
}) {
  const [canvas, setCanvas] = useState(initial)
  return (
    <SpatialEditor
      canvas={canvas}
      onChange={(next, command) => {
        setCanvas(next)
        onChange(next, command)
      }}
      measure={fakeMeasure}
      createId={createId}
    />
  )
}

afterEach(() => {
  cleanup()
})

describe('SpatialEditor (browser)', () => {
  it('renders the canvas-render svg for both nodes', async () => {
    const onChange = vi.fn()
    const { container } = render(
      <div style={{ width: 600, height: 400 }}>
        <SpatialEditor canvas={twoNodeCanvas()} onChange={onChange} measure={fakeMeasure} />
      </div>,
    )
    const rects = container.querySelectorAll('svg rect')
    expect(rects.length).toBeGreaterThanOrEqual(2)
  })

  it('dragging a node commits a move-node onChange with only that node changed', async () => {
    const onChange = vi.fn()
    const canvasValue = twoNodeCanvas()
    render(
      <div style={{ width: 600, height: 400 }}>
        <SpatialEditor canvas={canvasValue} onChange={onChange} measure={fakeMeasure} />
      </div>,
    )
    const editor = page.getByTestId('spatial-editor')

    // Node "a" chrome rect sits at canvas (20,20)-(120,80); pick a point inside it.
    await editor.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 40,
        clientY: 40,
        pointerId: 1,
        button: 0,
      }),
    )
    await editor
      .element()
      .dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, clientX: 70, clientY: 55, pointerId: 1 }),
      )
    await editor
      .element()
      .dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, clientX: 70, clientY: 55, pointerId: 1 }),
      )

    expect(onChange).toHaveBeenCalledTimes(1)
    const [next, command] = onChange.mock.calls[0] as [SpatialCanvas, unknown]
    expect(command).toEqual({ kind: 'move-node', id: 'a', x: 50, y: 35 })
    expect(next.nodes[1]).toEqual(canvasValue.nodes[1])
    // input untouched
    expect(canvasValue.nodes[0]).toEqual({
      id: 'a',
      type: 'text',
      x: 20,
      y: 20,
      width: 100,
      height: 60,
      text: 'hello',
    })
  })

  it('click on empty space clears selection without throwing', async () => {
    const onChange = vi.fn()
    render(
      <div style={{ width: 600, height: 400 }}>
        <SpatialEditor canvas={twoNodeCanvas()} onChange={onChange} measure={fakeMeasure} />
      </div>,
    )
    const editor = page.getByTestId('spatial-editor')
    await editor.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 500,
        clientY: 300,
        pointerId: 2,
        button: 0,
      }),
    )
    await editor
      .element()
      .dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, clientX: 500, clientY: 300, pointerId: 2 }),
      )
    expect(onChange).not.toHaveBeenCalled()
  })

  it('dragging the se resize handle grows the node, opposite corner fixed', async () => {
    const onChange = vi.fn()
    render(
      <div style={{ width: 600, height: 400 }}>
        <SpatialEditor canvas={twoNodeCanvas()} onChange={onChange} measure={fakeMeasure} />
      </div>,
    )
    const editor = page.getByTestId('spatial-editor')
    // Select node "a" (canvas box 20,20-120,80) first — the resize handle
    // only renders while a node is selected.
    await editor.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 40,
        clientY: 40,
        pointerId: 10,
        button: 0,
      }),
    )
    await editor
      .element()
      .dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, clientX: 40, clientY: 40, pointerId: 10 }),
      )

    const seHandle = page.getByTestId('resize-handle-se')
    await seHandle.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 120,
        clientY: 80,
        pointerId: 11,
        button: 0,
      }),
    )
    await editor.element().dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        clientX: 150,
        clientY: 100,
        pointerId: 11,
      }),
    )
    await editor
      .element()
      .dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, clientX: 150, clientY: 100, pointerId: 11 }),
      )

    expect(onChange).toHaveBeenCalledTimes(1)
    const [, command] = onChange.mock.calls[0] as [SpatialCanvas, unknown]
    // se growth by (30, 20): width/height grow, x/y (the nw corner) stay fixed.
    expect(command).toEqual({ kind: 'resize-node', id: 'a', x: 20, y: 20, width: 130, height: 80 })
  })

  it('dragging from the connect handle onto another node commits connect-nodes', async () => {
    const onChange = vi.fn()
    render(
      <div style={{ width: 600, height: 400 }}>
        <SpatialEditor
          canvas={twoNodeCanvas()}
          onChange={onChange}
          measure={fakeMeasure}
          createId={() => 'edge-1'}
        />
      </div>,
    )
    const editor = page.getByTestId('spatial-editor')
    await editor.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 40,
        clientY: 40,
        pointerId: 20,
        button: 0,
      }),
    )
    await editor
      .element()
      .dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, clientX: 40, clientY: 40, pointerId: 20 }),
      )

    const connectHandle = page.getByTestId('connect-handle')
    await connectHandle.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 130,
        clientY: 50,
        pointerId: 21,
        button: 0,
      }),
    )
    // Node "b" chrome rect sits at canvas (250,20)-(330,60); drop inside it.
    await editor
      .element()
      .dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, clientX: 280, clientY: 40, pointerId: 21 }),
      )

    expect(onChange).toHaveBeenCalledTimes(1)
    const [next, command] = onChange.mock.calls[0] as [SpatialCanvas, unknown]
    expect(command).toEqual({ kind: 'connect-nodes', edgeId: 'edge-1', fromNode: 'a', toNode: 'b' })
    expect(next.edges).toEqual([{ id: 'edge-1', fromNode: 'a', toNode: 'b' }])
  })

  it('arrow-key nudging a focused resize handle resizes the node (keyboard equivalent of drag)', async () => {
    const onChange = vi.fn()
    render(
      <div style={{ width: 600, height: 400 }}>
        <SpatialEditor canvas={twoNodeCanvas()} onChange={onChange} measure={fakeMeasure} />
      </div>,
    )
    const editor = page.getByTestId('spatial-editor')
    await editor.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 40,
        clientY: 40,
        pointerId: 50,
        button: 0,
      }),
    )
    await editor
      .element()
      .dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, clientX: 40, clientY: 40, pointerId: 50 }),
      )

    const seHandle = page.getByTestId('resize-handle-se')
    seHandle.element().focus()
    await seHandle
      .element()
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))

    // The component is controlled and onChange is a spy here (not fed back
    // as a new canvas prop), so this asserts a SINGLE nudge from the node's
    // original box — the same anchor-preserving math a real controlled
    // parent would apply on every discrete nudge.
    expect(onChange).toHaveBeenCalledTimes(1)
    const [, command] = onChange.mock.calls[0] as [SpatialCanvas, unknown]
    // Node "a" starts at (20,20)-(120,80). ArrowRight nudges the se corner's
    // width by RESIZE_KEYBOARD_STEP (8px), x/y (the nw corner) staying
    // fixed — the keyboard equivalent of dragging the se handle by (8, 0).
    expect(command).toEqual({ kind: 'resize-node', id: 'a', x: 20, y: 20, width: 108, height: 60 })
  })

  it('activating the connect handle then a target node via keyboard commits connect-nodes', async () => {
    const onChange = vi.fn()
    render(
      <div style={{ width: 600, height: 400 }}>
        <SpatialEditor
          canvas={twoNodeCanvas()}
          onChange={onChange}
          measure={fakeMeasure}
          createId={() => 'edge-2'}
        />
      </div>,
    )
    const editor = page.getByTestId('spatial-editor')
    await editor.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 40,
        clientY: 40,
        pointerId: 51,
        button: 0,
      }),
    )
    await editor
      .element()
      .dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, clientX: 40, clientY: 40, pointerId: 51 }),
      )

    const connectHandle = page.getByTestId('connect-handle')
    connectHandle.element().focus()
    await connectHandle
      .element()
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    await waitFor(() => {
      expect(page.getByTestId('connect-target-b').element()).toBeTruthy()
    })
    const target = page.getByTestId('connect-target-b').element()
    ;(target as HTMLElement).focus()
    await target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(onChange).toHaveBeenCalledTimes(1)
    const [next, command] = onChange.mock.calls[0] as [SpatialCanvas, unknown]
    expect(command).toEqual({ kind: 'connect-nodes', edgeId: 'edge-2', fromNode: 'a', toNode: 'b' })
    expect(next.edges).toEqual([{ id: 'edge-2', fromNode: 'a', toNode: 'b' }])
  })

  it('pressing Escape cancels an in-flight connecting gesture started via keyboard', async () => {
    const onChange = vi.fn()
    render(
      <div style={{ width: 600, height: 400 }}>
        <SpatialEditor canvas={twoNodeCanvas()} onChange={onChange} measure={fakeMeasure} />
      </div>,
    )
    const editor = page.getByTestId('spatial-editor')
    await editor.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 40,
        clientY: 40,
        pointerId: 52,
        button: 0,
      }),
    )
    await editor
      .element()
      .dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, clientX: 40, clientY: 40, pointerId: 52 }),
      )

    const connectHandle = page.getByTestId('connect-handle')
    connectHandle.element().focus()
    await connectHandle
      .element()
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await waitFor(() => {
      expect(page.getByTestId('connect-target-b').element()).toBeTruthy()
    })

    await editor
      .element()
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    await waitFor(() => {
      expect(() => page.getByTestId('connect-target-b').element()).toThrow()
    })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('double-clicking a text node opens the editor and commits the edited text on blur', async () => {
    const onChange = vi.fn()
    render(
      <div style={{ width: 600, height: 400 }}>
        <SpatialEditor canvas={twoNodeCanvas()} onChange={onChange} measure={fakeMeasure} />
      </div>,
    )
    const editor = page.getByTestId('spatial-editor')
    await editor.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 40,
        clientY: 40,
        pointerId: 30,
        button: 0,
      }),
    )
    await editor
      .element()
      .dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, clientX: 40, clientY: 40, pointerId: 30 }),
      )
    await editor.element().dispatchEvent(
      new MouseEvent('dblclick', {
        bubbles: true,
        clientX: 40,
        clientY: 40,
      }),
    )

    const textEditor = page.getByTestId('text-node-editor')
    await textEditor.fill('edited')
    ;(textEditor.element() as HTMLTextAreaElement).blur()

    expect(onChange).toHaveBeenCalledTimes(1)
    const [, command] = onChange.mock.calls[0] as [SpatialCanvas, unknown]
    expect(command).toEqual({ kind: 'set-text', id: 'a', text: 'edited' })
  })

  it('a pointerdown inside the open text editor does not discard the edit or start a move', async () => {
    const onChange = vi.fn()
    render(
      <div style={{ width: 600, height: 400 }}>
        <SpatialEditor canvas={twoNodeCanvas()} onChange={onChange} measure={fakeMeasure} />
      </div>,
    )
    const editor = page.getByTestId('spatial-editor')
    await editor.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 40,
        clientY: 40,
        pointerId: 40,
        button: 0,
      }),
    )
    await editor
      .element()
      .dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, clientX: 40, clientY: 40, pointerId: 40 }),
      )
    await editor.element().dispatchEvent(
      new MouseEvent('dblclick', {
        bubbles: true,
        clientX: 40,
        clientY: 40,
      }),
    )

    const textEditor = page.getByTestId('text-node-editor')
    await textEditor.fill('edited')
    // Placing the caret inside the already-open textarea must not bubble to
    // the root's hit-test and hijack the gesture into a node move — that
    // would unmount the editor and silently drop the in-progress edit.
    await textEditor.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 40,
        clientY: 40,
        pointerId: 41,
        button: 0,
      }),
    )

    expect(page.getByTestId('text-node-editor').element()).toBeTruthy()
    expect(onChange).not.toHaveBeenCalled()

    ;(textEditor.element() as HTMLTextAreaElement).blur()
    expect(onChange).toHaveBeenCalledTimes(1)
    const [, command] = onChange.mock.calls[0] as [SpatialCanvas, unknown]
    expect(command).toEqual({ kind: 'set-text', id: 'a', text: 'edited' })
  })

  it('ctrl+wheel zooms in, anchored under the cursor', async () => {
    const onChange = vi.fn()
    const { container } = render(
      <div style={{ width: 600, height: 400 }}>
        <SpatialEditor canvas={twoNodeCanvas()} onChange={onChange} measure={fakeMeasure} />
      </div>,
    )
    const editor = page.getByTestId('spatial-editor')
    const transformed = container.querySelector<HTMLDivElement>(
      '[data-testid="spatial-editor"] > div',
    )
    expect(transformed).not.toBeNull()
    expect(transformed?.style.transform).toBe('scale(1) translate(0px, 0px)')

    // Derive the expected translate from the root's OWN measured rect
    // rather than assuming it sits at client (0, 0) — handleWheel converts
    // clientX/clientY via clientPointToRootLocal, which subtracts
    // getBoundingClientRect(), so a body margin or test-harness wrapper
    // padding must not change the expected math here.
    const ZOOM_WHEEL_FACTOR = 1.1 // must track SpatialEditor.tsx's own constant
    const rect = editor.element().getBoundingClientRect()
    const anchorX = 100 - rect.left
    const anchorY = 100 - rect.top
    const expectedTranslate = (anchor: number) => anchor / ZOOM_WHEEL_FACTOR - anchor

    await editor.element().dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        clientX: 100,
        clientY: 100,
        deltaX: 0,
        deltaY: -100,
        ctrlKey: true,
      }),
    )

    // deltaY < 0 -> zoom IN by ZOOM_WHEEL_FACTOR (1.1), anchored so the
    // canvas point under the cursor stays fixed on screen. The browser
    // re-serializes the inline `transform` string with its own float
    // precision, so parse it instead of comparing byte-for-byte.
    await waitFor(() => {
      const match = transformed?.style.transform.match(
        /^scale\(([\d.]+)\) translate\((-?[\d.]+)px, (-?[\d.]+)px\)$/,
      )
      expect(match).not.toBeNull()
      const [, scale, tx, ty] = match as unknown as [string, string, string, string]
      expect(Number(scale)).toBeCloseTo(ZOOM_WHEEL_FACTOR, 5)
      expect(Number(tx)).toBeCloseTo(expectedTranslate(anchorX), 5)
      expect(Number(ty)).toBeCloseTo(expectedTranslate(anchorY), 5)
    })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('a wheel event actually gets its default (page scroll/zoom) suppressed', async () => {
    // React's onWheel is registered as a PASSIVE native listener, so
    // e.preventDefault() called from a React handler is a silent no-op —
    // handleWheel must reach the browser through a non-passive native
    // listener for this to have any effect at all.
    const onChange = vi.fn()
    render(
      <div style={{ width: 600, height: 400 }}>
        <SpatialEditor canvas={twoNodeCanvas()} onChange={onChange} measure={fakeMeasure} />
      </div>,
    )
    const editor = page.getByTestId('spatial-editor')
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: 100,
      deltaX: 0,
      deltaY: -100,
      ctrlKey: true,
    })
    editor.element().dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('a plain wheel pans the content opposite to the scroll delta', async () => {
    const onChange = vi.fn()
    const { container } = render(
      <div style={{ width: 600, height: 400 }}>
        <SpatialEditor canvas={twoNodeCanvas()} onChange={onChange} measure={fakeMeasure} />
      </div>,
    )
    const editor = page.getByTestId('spatial-editor')
    const transformed = container.querySelector<HTMLDivElement>(
      '[data-testid="spatial-editor"] > div',
    )
    expect(transformed).not.toBeNull()

    await editor.element().dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        clientX: 100,
        clientY: 100,
        deltaX: 20,
        deltaY: 30,
      }),
    )

    // A scroll wheel moves the CONTENT opposite to a drag of the same sign,
    // so a positive delta pans the canvas-space origin in the positive
    // direction (translate becomes more negative).
    await waitFor(() => {
      expect(transformed?.style.transform).toBe('scale(1) translate(-20px, -30px)')
    })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('unmounting mid-drag does not throw, never calls onChange afterward, releases pointer capture, and logs no console.error', async () => {
    const onChange = vi.fn()
    const consoleError = vi.spyOn(console, 'error')
    const releaseSpy = vi.spyOn(HTMLElement.prototype, 'releasePointerCapture')
    const { unmount } = render(
      <div style={{ width: 600, height: 400 }}>
        <SpatialEditor canvas={twoNodeCanvas()} onChange={onChange} measure={fakeMeasure} />
      </div>,
    )
    const editor = page.getByTestId('spatial-editor')
    await editor.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 40,
        clientY: 40,
        pointerId: 3,
        button: 0,
      }),
    )
    await editor
      .element()
      .dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, clientX: 90, clientY: 90, pointerId: 3 }),
      )
    await waitFor(() => expect(page.getByTestId('drag-preview').element()).toBeTruthy())
    expect(() => unmount()).not.toThrow()
    expect(onChange).not.toHaveBeenCalled()
    expect(releaseSpy).toHaveBeenCalledWith(3)
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
    releaseSpy.mockRestore()
  })

  it('drag preview tracks the pointer at several increasing deltas', async () => {
    const onChange = vi.fn()
    render(
      <div style={{ width: 600, height: 400 }}>
        <SpatialEditor canvas={twoNodeCanvas()} onChange={onChange} measure={fakeMeasure} />
      </div>,
    )
    const editor = page.getByTestId('spatial-editor')
    await editor.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 40,
        clientY: 40,
        pointerId: 200,
        button: 0,
      }),
    )
    const deltas = [
      { x: 10, y: 5 },
      { x: 30, y: 15 },
      { x: 60, y: 40 },
    ]
    let previousRectX: number | undefined
    let previousRectY: number | undefined
    for (const delta of deltas) {
      await editor.element().dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          clientX: 40 + delta.x,
          clientY: 40 + delta.y,
          pointerId: 200,
        }),
      )
      const expectedX = 20 + delta.x
      const expectedY = 20 + delta.y
      // Poll rather than read synchronously: a pointermove-driven React state
      // update is not guaranteed to have flushed to the DOM by the time
      // `dispatchEvent` returns (continuous-priority updates), unlike the
      // discrete pointerup commit other tests in this file assert on.
      await waitFor(() => {
        const rect = page.getByTestId('drag-preview').element().querySelector('rect')
        expect(rect).toBeTruthy()
        expect(Number(rect?.getAttribute('x'))).toBe(expectedX)
        expect(Number(rect?.getAttribute('y'))).toBe(expectedY)
      })
      const rect = page.getByTestId('drag-preview').element().querySelector('rect')
      const x = Number(rect?.getAttribute('x'))
      const y = Number(rect?.getAttribute('y'))
      if (previousRectX !== undefined && previousRectY !== undefined) {
        // Identity-viewport, so canvas-space offset equals screen-space offset.
        expect(x - previousRectX).toBe(delta.x - deltas[deltas.indexOf(delta) - 1]!.x)
        expect(y - previousRectY).toBe(delta.y - deltas[deltas.indexOf(delta) - 1]!.y)
      }
      previousRectX = x
      previousRectY = y
    }
    // Node "a" starts at canvas (20, 20); final delta is (60, 40).
    expect(previousRectX).toBe(20 + 60)
    expect(previousRectY).toBe(20 + 40)
    await editor.element().dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        clientX: 100,
        clientY: 80,
        pointerId: 200,
      }),
    )
    await waitFor(() => expect(page.getByTestId('drag-preview').element).toThrow())
  })

  it('resize preview tracks the handle drag and its final geometry equals the committed resize-node command', async () => {
    const onChange = vi.fn()
    render(
      <div style={{ width: 600, height: 400 }}>
        <SpatialEditor canvas={twoNodeCanvas()} onChange={onChange} measure={fakeMeasure} />
      </div>,
    )
    const editor = page.getByTestId('spatial-editor')
    await editor.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 40,
        clientY: 40,
        pointerId: 201,
        button: 0,
      }),
    )
    await editor
      .element()
      .dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, clientX: 40, clientY: 40, pointerId: 201 }),
      )
    const seHandle = page.getByTestId('resize-handle-se')
    await seHandle.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 120,
        clientY: 80,
        pointerId: 202,
        button: 0,
      }),
    )
    await editor.element().dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        clientX: 150,
        clientY: 100,
        pointerId: 202,
      }),
    )
    await waitFor(() => {
      const rect = page.getByTestId('drag-preview').element().querySelector('rect')
      expect(rect).toBeTruthy()
    })
    const previewRect = page.getByTestId('drag-preview').element().querySelector('rect')
    const previewGeometry = {
      x: Number(previewRect?.getAttribute('x')),
      y: Number(previewRect?.getAttribute('y')),
      width: Number(previewRect?.getAttribute('width')),
      height: Number(previewRect?.getAttribute('height')),
    }
    await editor.element().dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        clientX: 150,
        clientY: 100,
        pointerId: 202,
      }),
    )
    expect(onChange).toHaveBeenCalledTimes(1)
    const [, command] = onChange.mock.calls[0] as [SpatialCanvas, unknown]
    expect(command).toEqual({
      kind: 'resize-node',
      id: 'a',
      x: previewGeometry.x,
      y: previewGeometry.y,
      width: previewGeometry.width,
      height: previewGeometry.height,
    })
  })

  it('connect: a live line follows the pointer while connecting and disappears once the connection commits', async () => {
    const onChange = vi.fn()
    render(
      <div style={{ width: 600, height: 400 }}>
        <SpatialEditor
          canvas={twoNodeCanvas()}
          onChange={onChange}
          measure={fakeMeasure}
          createId={() => 'edge-preview'}
        />
      </div>,
    )
    const editor = page.getByTestId('spatial-editor')
    await editor.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 40,
        clientY: 40,
        pointerId: 203,
        button: 0,
      }),
    )
    await editor
      .element()
      .dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, clientX: 40, clientY: 40, pointerId: 203 }),
      )
    const connectHandle = page.getByTestId('connect-handle')
    await connectHandle.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 130,
        clientY: 50,
        pointerId: 204,
        button: 0,
      }),
    )
    await editor.element().dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        clientX: 200,
        clientY: 60,
        pointerId: 204,
      }),
    )
    await waitFor(() => {
      const line = page.getByTestId('drag-preview').element().querySelector('line')
      expect(line).toBeTruthy()
      expect(Number(line?.getAttribute('x2'))).toBe(200)
      expect(Number(line?.getAttribute('y2'))).toBe(60)
    })

    await editor.element().dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        clientX: 260,
        clientY: 45,
        pointerId: 204,
      }),
    )
    await waitFor(() => {
      const line = page.getByTestId('drag-preview').element().querySelector('line')
      expect(Number(line?.getAttribute('x2'))).toBe(260)
      expect(Number(line?.getAttribute('y2'))).toBe(45)
    })

    // Node "b" chrome rect sits at canvas (250,20)-(330,60); drop inside it.
    await editor
      .element()
      .dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, clientX: 280, clientY: 40, pointerId: 204 }),
      )
    await waitFor(() => expect(page.getByTestId('drag-preview').element).toThrow())
    expect(onChange).toHaveBeenCalledTimes(1)
    const [next, command] = onChange.mock.calls[0] as [SpatialCanvas, unknown]
    expect(command).toEqual({
      kind: 'connect-nodes',
      edgeId: 'edge-preview',
      fromNode: 'a',
      toNode: 'b',
    })
    expect(next.edges).toEqual([{ id: 'edge-preview', fromNode: 'a', toNode: 'b' }])
  })

  it('perf invariant: the committed scene is untouched and measure is not re-invoked while a drag is in flight', async () => {
    const onChange = vi.fn()
    const measure = vi.fn(fakeMeasure)
    const { container } = render(
      <div style={{ width: 600, height: 400 }}>
        <SpatialEditor canvas={twoNodeCanvas()} onChange={onChange} measure={measure} />
      </div>,
    )
    const editor = page.getByTestId('spatial-editor')
    const committedRectBefore = container.querySelector(
      'svg:not([data-testid="drag-preview"]) rect',
    )
    const xBefore = committedRectBefore?.getAttribute('x')
    const yBefore = committedRectBefore?.getAttribute('y')
    measure.mockClear()

    await editor.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 40,
        clientY: 40,
        pointerId: 205,
        button: 0,
      }),
    )
    for (const delta of [10, 20, 30, 40, 50]) {
      await editor.element().dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          clientX: 40 + delta,
          clientY: 40 + delta,
          pointerId: 205,
        }),
      )
    }
    // No layout/measure work happened: `canvas` never changed mid-gesture, so
    // the `useMemo` keyed on it never re-ran renderCanvasToSvg.
    expect(measure).not.toHaveBeenCalled()
    // The committed shape rect for node "a" is exactly where it started —
    // only the overlay preview tracked the pointer, not the real scene.
    const committedRectAfter = container.querySelector('svg:not([data-testid="drag-preview"]) rect')
    expect(committedRectAfter?.getAttribute('x')).toBe(xBefore)
    expect(committedRectAfter?.getAttribute('y')).toBe(yBefore)
    expect(onChange).not.toHaveBeenCalled()

    await editor
      .element()
      .dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, clientX: 90, clientY: 90, pointerId: 205 }),
      )
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('preview tracks the pointer 1:1 in canvas space under a non-identity viewport (panned + zoomed)', async () => {
    const onChange = vi.fn()
    const ref = createRef<SpatialEditorHandle>()
    render(
      <div style={{ width: 600, height: 400 }}>
        <SpatialEditor
          ref={ref}
          canvas={twoNodeCanvas()}
          onChange={onChange}
          measure={fakeMeasure}
        />
      </div>,
    )
    const editor = page.getByTestId('spatial-editor')
    // Set a known non-identity viewport directly via the imperative handle
    // rather than replaying wheel-event math — this isolates the property
    // under test (preview tracks in CANVAS space) from viewport.ts's own
    // zoom/pan arithmetic, which has its own dedicated tests.
    act(() => {
      ref.current?.setViewport({ x: 5, y: 5, zoom: 2 })
    })

    await editor.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 60,
        clientY: 60,
        pointerId: 206,
        button: 0,
      }),
    )
    const rectAt = () =>
      page.getByTestId('drag-preview').element().querySelector('rect') as SVGRectElement
    await editor.element().dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        clientX: 80,
        clientY: 90,
        pointerId: 206,
      }),
    )
    await waitFor(() => expect(rectAt()).toBeTruthy())
    const first = { x: Number(rectAt().getAttribute('x')), y: Number(rectAt().getAttribute('y')) }
    await editor.element().dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        clientX: 80 + 40,
        clientY: 90 + 20,
        pointerId: 206,
      }),
    )
    await waitFor(() => {
      const rect = rectAt()
      expect(Number(rect.getAttribute('x')) - first.x).toBeCloseTo(20, 5)
    })
    const second = { x: Number(rectAt().getAttribute('x')), y: Number(rectAt().getAttribute('y')) }
    // Screen-space delta (40, 20) at zoom 2 is canvas-space delta (20, 10) —
    // the preview must move by the CANVAS-space amount, not the raw
    // screen-space pointer delta, since it draws inside the zoomed content.
    expect(second.x - first.x).toBeCloseTo(20, 5)
    expect(second.y - first.y).toBeCloseTo(10, 5)
    await editor.element().dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        clientX: 120,
        clientY: 110,
        pointerId: 206,
      }),
    )
  })

  it('Escape mid-drag removes the preview and commits nothing', async () => {
    const onChange = vi.fn()
    render(
      <div style={{ width: 600, height: 400 }}>
        <SpatialEditor canvas={twoNodeCanvas()} onChange={onChange} measure={fakeMeasure} />
      </div>,
    )
    const editor = page.getByTestId('spatial-editor')
    await editor.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 40,
        clientY: 40,
        pointerId: 207,
        button: 0,
      }),
    )
    await editor.element().dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        clientX: 90,
        clientY: 90,
        pointerId: 207,
      }),
    )
    await waitFor(() => expect(page.getByTestId('drag-preview').element()).toBeTruthy())
    await editor
      .element()
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await waitFor(() => expect(page.getByTestId('drag-preview').element).toThrow())
    await editor
      .element()
      .dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, clientX: 90, clientY: 90, pointerId: 207 }),
      )
    expect(onChange).not.toHaveBeenCalled()
  })

  it('a local canvas swap that keeps the gesture target valid leaves the gesture and preview alive', async () => {
    const onChange = vi.fn()
    const initial = twoNodeCanvas()
    const { rerender } = render(
      <div style={{ width: 600, height: 400 }}>
        <SpatialEditor canvas={initial} onChange={onChange} measure={fakeMeasure} />
      </div>,
    )
    const editor = page.getByTestId('spatial-editor')
    await editor.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 40,
        clientY: 40,
        pointerId: 208,
        button: 0,
      }),
    )
    await editor.element().dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        clientX: 90,
        clientY: 90,
        pointerId: 208,
      }),
    )
    await waitFor(() => expect(page.getByTestId('drag-preview').element()).toBeTruthy())

    // Same target node, same type, unrelated node "b" edited — this is a
    // LOCAL replacement (no externalVersion bump), so the gesture must
    // continue rather than abort (gestures.ts's canvas-replaced contract).
    const sameTargetStillValid: SpatialCanvas = {
      nodes: [initial.nodes[0]!, { ...initial.nodes[1]!, x: 999 }],
      edges: [],
    }
    rerender(
      <div style={{ width: 600, height: 400 }}>
        <SpatialEditor canvas={sameTargetStillValid} onChange={onChange} measure={fakeMeasure} />
      </div>,
    )
    expect(page.getByTestId('drag-preview').element()).toBeTruthy()
    await editor
      .element()
      .dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, clientX: 90, clientY: 90, pointerId: 208 }),
      )
    expect(onChange).toHaveBeenCalledTimes(1)
    const [, command] = onChange.mock.calls[0] as [SpatialCanvas, unknown]
    expect(command).toEqual({ kind: 'move-node', id: 'a', x: 70, y: 70 })
  })

  it('double-clicking empty canvas space creates a node and opens it for typing immediately (no second double-click)', async () => {
    const onChange = vi.fn()
    render(
      <div style={{ width: 600, height: 400 }}>
        <ControlledEditor
          initial={twoNodeCanvas()}
          onChange={onChange}
          createId={() => 'new-node'}
        />
      </div>,
    )
    const editor = page.getByTestId('spatial-editor')
    // Empty space: far from both node "a" (20,20-120,80) and node "b" (250,20-330,60).
    await editor.element().dispatchEvent(
      new MouseEvent('dblclick', {
        bubbles: true,
        clientX: 500,
        clientY: 300,
      }),
    )

    const textEditor = page.getByTestId('text-node-editor')
    expect(textEditor.element()).toBeTruthy()
    expect(document.activeElement).toBe(textEditor.element())

    await textEditor.fill('my first note')
    ;(textEditor.element() as HTMLTextAreaElement).blur()

    expect(onChange).toHaveBeenCalledTimes(2)
    const [firstNext, firstCommand] = onChange.mock.calls[0] as [SpatialCanvas, unknown]
    expect(firstCommand).toMatchObject({ kind: 'create-node', node: { id: 'new-node', text: '' } })
    expect(firstNext.nodes.map((n) => n.id)).toContain('new-node')
    const [, secondCommand] = onChange.mock.calls[1] as [SpatialCanvas, unknown]
    expect(secondCommand).toEqual({ kind: 'set-text', id: 'new-node', text: 'my first note' })
  })

  it('the Add note button creates a node at viewport center via a real click', async () => {
    const onChange = vi.fn()
    render(
      <div style={{ width: 600, height: 400 }}>
        <SpatialEditor
          canvas={twoNodeCanvas()}
          onChange={onChange}
          measure={fakeMeasure}
          createId={() => 'add-note-1'}
        />
      </div>,
    )
    // A REAL pointer sequence (pointerdown -> pointerup -> click), not a
    // synthetic MouseEvent: the synthetic form skips pointerdown and so
    // cannot detect the root capturing the pointer and swallowing the
    // button's click — the bug that made this button do nothing in the
    // running app while this test stayed green.
    await userEvent.click(page.getByTestId('add-node-button'))

    expect(onChange).toHaveBeenCalledTimes(1)
    const [next, command] = onChange.mock.calls[0] as [SpatialCanvas, unknown]
    expect(command).toMatchObject({ kind: 'create-node', node: { id: 'add-note-1' } })
    expect(next.nodes.map((n) => n.id)).toContain('add-note-1')
  })

  it('the Add note button is reachable and activatable via keyboard (Enter)', async () => {
    const onChange = vi.fn()
    render(
      <div style={{ width: 600, height: 400 }}>
        <SpatialEditor
          canvas={twoNodeCanvas()}
          onChange={onChange}
          measure={fakeMeasure}
          createId={() => 'add-note-2'}
        />
      </div>,
    )
    const button = page.getByTestId('add-node-button')
    ;(button.element() as HTMLButtonElement).focus()
    expect(document.activeElement).toBe(button.element())
    // A real key press through the browser, not a synthetic keydown followed
    // by a synthetic click: dispatching the click ourselves would exercise
    // the mouse path and prove nothing about keyboard reachability, which is
    // the whole point of this case.
    await userEvent.keyboard('{Enter}')

    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('select a node then Delete removes it from the next canvas and clears the selection overlay', async () => {
    const onChange = vi.fn()
    const { container } = render(
      <div style={{ width: 600, height: 400 }}>
        <SpatialEditor canvas={twoNodeCanvas()} onChange={onChange} measure={fakeMeasure} />
      </div>,
    )
    const editor = page.getByTestId('spatial-editor')
    await editor.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 40,
        clientY: 40,
        pointerId: 60,
        button: 0,
      }),
    )
    await editor
      .element()
      .dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, clientX: 40, clientY: 40, pointerId: 60 }),
      )
    expect(container.querySelector('[data-testid="resize-handle-se"]')).not.toBeNull()

    await editor
      .element()
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))

    expect(onChange).toHaveBeenCalledTimes(1)
    const [next, command] = onChange.mock.calls[0] as [SpatialCanvas, unknown]
    expect(command).toEqual({ kind: 'delete-node', id: 'a' })
    expect(next.nodes.map((n) => n.id)).toEqual(['b'])
    await waitFor(() => {
      expect(container.querySelector('[data-testid="resize-handle-se"]')).toBeNull()
    })
  })

  it('select a node then Backspace also deletes it', async () => {
    const onChange = vi.fn()
    render(
      <div style={{ width: 600, height: 400 }}>
        <SpatialEditor canvas={twoNodeCanvas()} onChange={onChange} measure={fakeMeasure} />
      </div>,
    )
    const editor = page.getByTestId('spatial-editor')
    await editor.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 40,
        clientY: 40,
        pointerId: 61,
        button: 0,
      }),
    )
    await editor
      .element()
      .dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, clientX: 40, clientY: 40, pointerId: 61 }),
      )
    await editor
      .element()
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }))

    expect(onChange).toHaveBeenCalledTimes(1)
    const [, command] = onChange.mock.calls[0] as [SpatialCanvas, unknown]
    expect(command).toEqual({ kind: 'delete-node', id: 'a' })
  })

  it('while the text editor is open, Backspace edits the textarea and does NOT delete the node', async () => {
    const onChange = vi.fn()
    render(
      <div style={{ width: 600, height: 400 }}>
        <SpatialEditor canvas={twoNodeCanvas()} onChange={onChange} measure={fakeMeasure} />
      </div>,
    )
    const editor = page.getByTestId('spatial-editor')
    await editor.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 40,
        clientY: 40,
        pointerId: 62,
        button: 0,
      }),
    )
    await editor
      .element()
      .dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, clientX: 40, clientY: 40, pointerId: 62 }),
      )
    await editor.element().dispatchEvent(
      new MouseEvent('dblclick', {
        bubbles: true,
        clientX: 40,
        clientY: 40,
      }),
    )

    const textEditor = page.getByTestId('text-node-editor')
    await textEditor.fill('hell')
    await textEditor
      .element()
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }),
      )

    // The node must still exist — the reducer's editing-text guard means no
    // delete-node command was ever emitted from this keystroke.
    expect(onChange).not.toHaveBeenCalled()
    expect(page.getByTestId('text-node-editor').element()).toBeTruthy()
    ;(textEditor.element() as HTMLTextAreaElement).blur()
    expect(onChange).toHaveBeenCalledTimes(1)
    const [, command] = onChange.mock.calls[0] as [SpatialCanvas, unknown]
    expect(command).toEqual({ kind: 'set-text', id: 'a', text: 'hell' })
  })

  it('creating two nodes, connecting them, then deleting one leaves no dangling edge in the canvas or the rendered SVG', async () => {
    const onChange = vi.fn()
    let ids = 0
    const { container } = render(
      <div style={{ width: 600, height: 400 }}>
        <ControlledEditor
          initial={{ nodes: [], edges: [] }}
          onChange={onChange}
          createId={() => `id-${++ids}`}
        />
      </div>,
    )
    const editor = page.getByTestId('spatial-editor')

    // Create node 1 at (100, 100), commit empty text via blur.
    await editor
      .element()
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 100, clientY: 100 }))
    let textEditor = page.getByTestId('text-node-editor')
    ;(textEditor.element() as HTMLTextAreaElement).blur()
    let canvas = onChange.mock.calls.at(-1)![0] as SpatialCanvas
    expect(canvas.nodes).toHaveLength(1)
    // Wait for ControlledEditor's setCanvas to actually flush and re-render
    // SpatialEditor with the updated `canvas` prop (evidenced by the
    // TextNodeEditor unmounting) — otherwise the next dblclick's handler
    // closure still sees the PRE-create (empty) canvas, and the next create
    // silently overwrites node 1 instead of adding node 2.
    await waitFor(() => {
      expect(() => page.getByTestId('text-node-editor').element()).toThrow()
    })

    // Create node 2 at (400, 100), commit.
    await editor
      .element()
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 400, clientY: 100 }))
    textEditor = page.getByTestId('text-node-editor')
    ;(textEditor.element() as HTMLTextAreaElement).blur()
    canvas = onChange.mock.calls.at(-1)![0] as SpatialCanvas
    expect(canvas.nodes).toHaveLength(2)
    await waitFor(() => {
      expect(() => page.getByTestId('text-node-editor').element()).toThrow()
    })

    // Select node 1, connect it to node 2 via the connect handle.
    const node1Box = canvas.nodes[0]!
    const node2Box = canvas.nodes[1]!
    await editor.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: node1Box.x + 10,
        clientY: node1Box.y + 10,
        pointerId: 70,
        button: 0,
      }),
    )
    await editor.element().dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        clientX: node1Box.x + 10,
        clientY: node1Box.y + 10,
        pointerId: 70,
      }),
    )
    const connectHandle = page.getByTestId('connect-handle')
    await connectHandle.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: node1Box.x + node1Box.width,
        clientY: node1Box.y + node1Box.height / 2,
        pointerId: 71,
        button: 0,
      }),
    )
    await editor.element().dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        clientX: node2Box.x + 10,
        clientY: node2Box.y + 10,
        pointerId: 71,
      }),
    )
    canvas = onChange.mock.calls.at(-1)![0] as SpatialCanvas
    expect(canvas.edges).toHaveLength(1)
    const edgeId = canvas.edges[0]!.id
    expect(canvas.edges[0]).toEqual({ id: edgeId, fromNode: node1Box.id, toNode: node2Box.id })

    // Select node 1 again, delete it.
    await editor.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: node1Box.x + 10,
        clientY: node1Box.y + 10,
        pointerId: 72,
        button: 0,
      }),
    )
    await editor.element().dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        clientX: node1Box.x + 10,
        clientY: node1Box.y + 10,
        pointerId: 72,
      }),
    )
    await editor
      .element()
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))

    canvas = onChange.mock.calls.at(-1)![0] as SpatialCanvas
    expect(canvas.nodes.map((n) => n.id)).toEqual([node2Box.id])
    expect(canvas.edges).toEqual([])

    await waitFor(() => {
      const svgText = container.querySelector('[data-testid="spatial-editor"]')?.innerHTML ?? ''
      expect(svgText).not.toContain(edgeId)
    })
  })

  it('deleting the node an in-flight move gesture targets (canvas replaced mid-drag) does not throw and commits nothing', async () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <div style={{ width: 600, height: 400 }}>
        <SpatialEditor canvas={twoNodeCanvas()} onChange={onChange} measure={fakeMeasure} />
      </div>,
    )
    const editor = page.getByTestId('spatial-editor')
    await editor.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 40,
        clientY: 40,
        pointerId: 80,
        button: 0,
      }),
    )
    await editor
      .element()
      .dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, clientX: 60, clientY: 60, pointerId: 80 }),
      )
    await waitFor(() => expect(page.getByTestId('drag-preview').element()).toBeTruthy())

    const withoutA: SpatialCanvas = { nodes: [twoNodeCanvas().nodes[1]!], edges: [] }
    expect(() =>
      rerender(
        <div style={{ width: 600, height: 400 }}>
          <SpatialEditor
            canvas={withoutA}
            onChange={onChange}
            measure={fakeMeasure}
            externalVersion={1}
          />
        </div>,
      ),
    ).not.toThrow()
    // The abort must retire the preview too — a canvas-replaced abort with a
    // stale preview left behind was the spike's own documented gap.
    expect(page.getByTestId('drag-preview').element).toThrow()

    await editor
      .element()
      .dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, clientX: 60, clientY: 60, pointerId: 80 }),
      )
    expect(onChange).not.toHaveBeenCalled()
  })

  it('losing pointer capture mid-gesture cancels it, so a later pointerup commits nothing', async () => {
    const onChange = vi.fn()
    render(
      <div style={{ width: 600, height: 400 }}>
        <SpatialEditor canvas={twoNodeCanvas()} onChange={onChange} measure={fakeMeasure} />
      </div>,
    )
    const editor = page.getByTestId('spatial-editor')
    await editor.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 40,
        clientY: 40,
        pointerId: 4,
        button: 0,
      }),
    )
    await editor
      .element()
      .dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, clientX: 55, clientY: 45, pointerId: 4 }),
      )
    await waitFor(() => expect(page.getByTestId('drag-preview').element()).toBeTruthy())
    // Simulates the platform revoking capture (e.g. the setPointerCapture
    // rejection this component's trySetPointerCapture swallows) rather than
    // a normal pointerup/pointercancel.
    await editor
      .element()
      .dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 4 }))
    await waitFor(() => expect(page.getByTestId('drag-preview').element).toThrow())
    // Give React a frame to commit the cancellation before the next event —
    // lostpointercapture and pointerup are dispatched back-to-back here in a
    // way no real gesture ever would be, so nothing later in this test
    // depends on this tick's exact timing.
    await new Promise((resolve) => setTimeout(resolve, 50))
    await editor
      .element()
      .dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, clientX: 70, clientY: 55, pointerId: 4 }),
      )

    expect(onChange).not.toHaveBeenCalled()
  })
})

/**
 * Regression coverage for four spatial-text-layout defects fixed together:
 * a clipped first heading line, a markdown list flattening to inline text,
 * unwrapped text overflowing its node's right edge, and an undrawn edge
 * label. Uses the real Canvas 2D measurer (no `measure` override) so the
 * geometry reflects an actual browser render, not a fake fixed-width one.
 */
function fourDefectCanvas(): SpatialCanvas {
  return {
    nodes: [
      {
        id: 'heading-node',
        type: 'text',
        x: 20,
        y: 20,
        width: 220,
        height: 110,
        text: '# Heading\n\nSome body text.',
      },
      {
        id: 'list-node',
        type: 'text',
        x: 280,
        y: 20,
        width: 220,
        height: 110,
        text: 'Second node\n\n- list item\n- another',
      },
      {
        id: 'overflow-node',
        type: 'text',
        x: 20,
        y: 170,
        width: 160,
        height: 90,
        text: 'This is a long line of text that should wrap inside its node instead of overflowing the right edge',
      },
    ],
    edges: [{ id: 'e1', fromNode: 'heading-node', toNode: 'list-node', label: 'edge label' }],
  }
}

describe('SpatialEditor (browser) — spatial text layout defects', () => {
  it('renders a heading, a list, wrapped overflow text, and an edge label without the four defects', async () => {
    const onChange = vi.fn()
    const { container } = render(
      <div style={{ width: 900, height: 600 }}>
        <SpatialEditor canvas={fourDefectCanvas()} onChange={onChange} />
      </div>,
    )

    await waitFor(() => {
      expect(container.querySelectorAll('svg text').length).toBeGreaterThan(0)
    })

    await page.screenshot({
      // Resolved relative to this test file's own directory by vitest's
      // browser screenshot API — walk up to the repo-root tmp/ bucket
      // rather than nesting a tmp/ under this source directory.
      path: '../../../../../tmp/screenshots/spatial-editor-four-defects-after.png',
    })

    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()

    // Defect 1: the heading's first line must sit below the node chrome's
    // top edge (not straddle it) — compare the heading run's rendered
    // client rect against the node's own chrome rect.
    const nodeRects = Array.from(container.querySelectorAll('svg rect'))
    const headingRect = nodeRects[0]
    expect(headingRect).toBeTruthy()
    const headingTexts = Array.from(container.querySelectorAll('svg text'))
    const headingRun = headingTexts.find((t) => t.textContent === 'Heading')
    expect(headingRun).toBeTruthy()
    if (headingRect && headingRun) {
      const chromeBox = headingRect.getBoundingClientRect()
      const runBox = headingRun.getBoundingClientRect()
      expect(runBox.top).toBeGreaterThanOrEqual(chromeBox.top)
    }

    // Defect 2: the list body renders each list item as its own run on its
    // own line, not flattened into a single inline line with the preceding
    // paragraph (the pre-fix output was the single merged line
    // "Second node - list item - another").
    const secondNodeRun = headingTexts.find((t) => t.textContent === 'Second node')
    const listItemRun = headingTexts.find((t) => t.textContent === 'list item')
    const anotherRun = headingTexts.find((t) => t.textContent === 'another')
    expect(secondNodeRun).toBeTruthy()
    expect(listItemRun).toBeTruthy()
    expect(anotherRun).toBeTruthy()
    const flattenedRun = headingTexts.find((t) =>
      t.textContent?.includes('Second node - list item - another'),
    )
    expect(flattenedRun).toBeUndefined()
    if (secondNodeRun && listItemRun && anotherRun) {
      const secondNodeY = secondNodeRun.getBoundingClientRect().top
      const listItemY = listItemRun.getBoundingClientRect().top
      const anotherY = anotherRun.getBoundingClientRect().top
      expect(listItemY).toBeGreaterThan(secondNodeY)
      expect(anotherY).toBeGreaterThan(listItemY)
    }

    // Defect 3: no run's right edge should extend past its node's chrome
    // rect (allowing the single-unbreakable-token fallback is not exercised
    // by this body, since every word here is shorter than the node width).
    const overflowChrome = nodeRects[2]
    expect(overflowChrome).toBeTruthy()
    if (overflowChrome) {
      const chromeBox = overflowChrome.getBoundingClientRect()
      const overflowRuns = headingTexts.filter(
        (t) => t.textContent && chromeBox.left <= t.getBoundingClientRect().left,
      )
      for (const run of overflowRuns) {
        const runBox = run.getBoundingClientRect()
        if (runBox.top >= chromeBox.top && runBox.bottom <= chromeBox.bottom + 1) {
          expect(runBox.right).toBeLessThanOrEqual(chromeBox.right + 1)
        }
      }
    }

    // Defect 4: the edge label text is present in the rendered SVG.
    const edgeLabel = headingTexts.find((t) => t.textContent === 'edge label')
    expect(edgeLabel).toBeTruthy()
  })
})

function boxesOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

describe('node placement and affordances', () => {
  it('two consecutive Add note clicks with no other interaction do not overlap', async () => {
    const onChange = vi.fn()
    let ids = 0
    render(
      <div style={{ width: 600, height: 400 }}>
        <ControlledEditor
          initial={{ nodes: [], edges: [] }}
          onChange={onChange}
          createId={() => `add-note-${++ids}`}
        />
      </div>,
    )
    const button = page.getByTestId('add-node-button')
    await button.element().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await waitFor(() => {
      const canvas = onChange.mock.calls.at(-1)![0] as SpatialCanvas
      expect(canvas.nodes).toHaveLength(1)
    })
    await button.element().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await waitFor(() => {
      const canvas = onChange.mock.calls.at(-1)![0] as SpatialCanvas
      expect(canvas.nodes).toHaveLength(2)
    })
    const finalCanvas = onChange.mock.calls.at(-1)![0] as SpatialCanvas
    const [first, second] = finalCanvas.nodes
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(boxesOverlap(first!, second!)).toBe(false)
  })

  it('clicking empty canvas commits typed text instead of losing it (click-away commits)', async () => {
    const onChange = vi.fn()
    render(
      <div style={{ width: 600, height: 400 }}>
        <ControlledEditor
          initial={{ nodes: [], edges: [] }}
          onChange={onChange}
          createId={() => 'note-1'}
        />
      </div>,
    )
    const editor = page.getByTestId('spatial-editor')
    const button = page.getByTestId('add-node-button')
    await button.element().dispatchEvent(new MouseEvent('click', { bubbles: true }))

    const textEditor = page.getByTestId('text-node-editor')
    await textEditor.fill('typed before clicking away')

    // Click far-away empty canvas space rather than blurring the textarea
    // directly — this is the pointerdown-empty path the reducer must commit
    // through, not commit-text-edit dispatched directly.
    await editor.element().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 580,
        clientY: 380,
        pointerId: 90,
        button: 0,
      }),
    )
    await editor.element().dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        clientX: 580,
        clientY: 380,
        pointerId: 90,
      }),
    )

    await waitFor(() => {
      const canvas = onChange.mock.calls.at(-1)![0] as SpatialCanvas
      const node = canvas.nodes.find((n) => n.id === 'note-1')
      expect(node?.type === 'text' ? node.text : undefined).toBe('typed before clicking away')
    })
  })

  it('pressing Escape still discards typed text (the one documented discard path)', async () => {
    const onChange = vi.fn()
    render(
      <div style={{ width: 600, height: 400 }}>
        <ControlledEditor
          initial={{ nodes: [], edges: [] }}
          onChange={onChange}
          createId={() => 'note-2'}
        />
      </div>,
    )
    const button = page.getByTestId('add-node-button')
    await button.element().dispatchEvent(new MouseEvent('click', { bubbles: true }))

    const textEditor = page.getByTestId('text-node-editor')
    await textEditor.fill('should be discarded')
    await textEditor
      .element()
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    const canvas = onChange.mock.calls.at(-1)![0] as SpatialCanvas
    const node = canvas.nodes.find((n) => n.id === 'note-2')
    expect(node?.type === 'text' ? node.text : undefined).toBe('')
  })

  it('the Add note button has real, visible button affordance (not a bare, transparent element)', async () => {
    render(
      <div style={{ width: 600, height: 400 }}>
        <SpatialEditor canvas={{ nodes: [], edges: [] }} onChange={vi.fn()} measure={fakeMeasure} />
      </div>,
    )
    const button = page.getByTestId('add-node-button').element() as HTMLButtonElement
    const style = getComputedStyle(button)
    const hasVisibleBackground = style.backgroundColor !== 'rgba(0, 0, 0, 0)'
    const hasVisibleBorder = Number.parseFloat(style.borderWidth) > 0
    expect(hasVisibleBackground || hasVisibleBorder).toBe(true)
    expect(
      Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingLeft),
    ).toBeGreaterThan(0)
    button.focus()
    expect(document.activeElement).toBe(button)
  })
})
