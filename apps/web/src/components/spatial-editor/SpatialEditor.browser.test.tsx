/**
 * Real-browser interaction coverage — pointer capture, drag-to-move, and
 * unmount-mid-gesture are exactly what jsdom cannot exercise faithfully.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

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

  it('unmounting mid-drag does not throw and never calls onChange afterward', async () => {
    const onChange = vi.fn()
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
    expect(() => unmount()).not.toThrow()
    expect(onChange).not.toHaveBeenCalled()
  })
})
