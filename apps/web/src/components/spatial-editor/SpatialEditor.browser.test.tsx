/**
 * Real-browser interaction coverage — pointer capture, drag-to-move, and
 * unmount-mid-gesture are exactly what jsdom cannot exercise faithfully.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, render } from '@testing-library/react'
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
