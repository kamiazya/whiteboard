/**
 * jsdom-level coverage for the imperative `SpatialEditorHandle` (no real
 * pointer/layout behavior is under test here — see SpatialEditor.browser.test.tsx
 * for that) and for the `externalVersion`-driven local/external origin
 * distinction on a mid-gesture canvas prop swap.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

function transformOf(container: HTMLElement) {
  return container.querySelector<HTMLDivElement>('[data-testid="viewport-transform"]')?.style
    .transform
}

afterEach(() => {
  cleanup()
})

describe('Add button (creation menu)', () => {
  it('opens the + menu whose entries create without a selection', () => {
    const onChange = vi.fn()
    const { getByTestId, getByRole } = render(
      <SpatialEditor
        defaultTool="select"
        canvas={twoNodeCanvas()}
        onChange={onChange}
        measure={fakeMeasure}
      />,
    )
    const button = getByTestId('add-button') as HTMLButtonElement
    expect(button.tagName).toBe('BUTTON')
    // Icon-only since the chrome iconification: the accessible name lives
    // on aria-label, which is what assistive tech (and getByRole) resolve.
    expect(button.getAttribute('aria-label')).toBe('Add')
    expect(button.getAttribute('aria-haspopup')).toBe('menu')

    fireEvent.click(button)
    const item = getByRole('menuitem', { name: 'Add note' })
    fireEvent.click(item)
    expect(onChange).toHaveBeenCalled()
    const command = onChange.mock.calls[0][1] as { kind: string }
    expect(command.kind).toBe('create-node')
  })

  it('Escape closes the menu and hands focus back to the + trigger', () => {
    // Programmatic focus reads as focus-visible to Radix, which opens the
    // trigger's tooltip and measures it — jsdom has no ResizeObserver, so
    // stub the minimal contract for this test only.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    const { getByTestId } = render(
      <SpatialEditor
        defaultTool="select"
        canvas={twoNodeCanvas()}
        onChange={vi.fn()}
        measure={fakeMeasure}
      />,
    )
    const button = getByTestId('add-button') as HTMLButtonElement
    fireEvent.click(button)
    const menu = getByTestId('add-menu')
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(getByTestId('tool-palette').querySelector('[data-testid="add-menu"]')).toBeNull()
    // Closing unmounts the focused entry — without the hand-back, focus
    // falls to <body> and the keyboard user loses their place.
    expect(document.activeElement).toBe(button)
    vi.unstubAllGlobals()
  })
})

describe('SpatialEditorHandle', () => {
  it('setViewport applies the given viewport to the rendered transform', () => {
    const ref = createRef<SpatialEditorHandle>()
    const { container } = render(
      <SpatialEditor
        defaultTool="select"
        ref={ref}
        canvas={twoNodeCanvas()}
        onChange={vi.fn()}
        measure={fakeMeasure}
      />,
    )
    expect(transformOf(container)).toBe('scale(1) translate(0px, 0px)')

    act(() => {
      ref.current?.setViewport({ x: 10, y: -5, zoom: 2 })
    })

    expect(transformOf(container)).toBe('scale(2) translate(-10px, 5px)')
  })

  it('fitToContent(nodeIds) fits the viewport to only the named nodes', () => {
    const ref = createRef<SpatialEditorHandle>()
    const { container } = render(
      <SpatialEditor
        defaultTool="select"
        ref={ref}
        canvas={twoNodeCanvas()}
        onChange={vi.fn()}
        measure={fakeMeasure}
      />,
    )

    act(() => {
      ref.current?.fitToContent(['b'])
    })

    // Node "b"'s chrome box starts at canvas (250, 20) — fitViewportToBoxes
    // shows that top-left at screen origin, at identity zoom.
    expect(transformOf(container)).toBe('scale(1) translate(-250px, -20px)')
  })

  it('fitToContent() with no ids fits the viewport to every node', () => {
    const ref = createRef<SpatialEditorHandle>()
    const { container } = render(
      <SpatialEditor
        defaultTool="select"
        ref={ref}
        canvas={twoNodeCanvas()}
        onChange={vi.fn()}
        measure={fakeMeasure}
      />,
    )

    act(() => {
      ref.current?.fitToContent()
    })

    // Leftmost/topmost across both nodes is node "a" at (20, 20).
    expect(transformOf(container)).toBe('scale(1) translate(-20px, -20px)')
  })
})

describe('SpatialEditor externalVersion origin handling', () => {
  function dragNodeA(root: HTMLElement) {
    root.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 40,
        clientY: 40,
        pointerId: 1,
        button: 0,
      }),
    )
    root.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 70, clientY: 55, pointerId: 1 }),
    )
  }

  it('bumping externalVersion alongside a canvas prop swap cancels an in-flight drag', () => {
    const onChange = vi.fn()
    const canvasValue = twoNodeCanvas()
    const { container, rerender } = render(
      <SpatialEditor
        defaultTool="select"
        canvas={canvasValue}
        externalVersion={0}
        onChange={onChange}
        measure={fakeMeasure}
      />,
    )
    const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
    dragNodeA(root)

    // Same node contents (the undo/redo shape) but externalVersion advanced.
    rerender(
      <SpatialEditor
        defaultTool="select"
        canvas={{ ...canvasValue }}
        externalVersion={1}
        onChange={onChange}
        measure={fakeMeasure}
      />,
    )

    root.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, clientX: 70, clientY: 55, pointerId: 1 }),
    )

    expect(onChange).not.toHaveBeenCalled()
  })

  it('a canvas prop swap with externalVersion unchanged leaves an in-flight drag intact', () => {
    const onChange = vi.fn()
    const canvasValue = twoNodeCanvas()
    const { container, rerender } = render(
      <SpatialEditor
        defaultTool="select"
        canvas={canvasValue}
        externalVersion={0}
        onChange={onChange}
        measure={fakeMeasure}
      />,
    )
    const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
    dragNodeA(root)

    // Same node contents, externalVersion NOT advanced -> this component's
    // own controlled re-render after onChange, not an external replacement.
    rerender(
      <SpatialEditor
        defaultTool="select"
        canvas={{ ...canvasValue }}
        externalVersion={0}
        onChange={onChange}
        measure={fakeMeasure}
      />,
    )

    root.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, clientX: 70, clientY: 55, pointerId: 1 }),
    )

    expect(onChange).toHaveBeenCalledTimes(1)
    const [, command] = onChange.mock.calls[0] as [SpatialCanvas, unknown]
    expect(command).toEqual({ kind: 'move-node', id: 'a', x: 50, y: 35 })
  })
})

describe('bottom dock composition', () => {
  it('renders paletteLeading inside the ONE tool-palette container', () => {
    // The dock is the single layout authority for bottom chrome: host-
    // supplied groups (undo/redo/versions) join the palette's own flex
    // container instead of floating as an independently positioned island —
    // independently positioned islands collide as tools grow (the phone
    // overlap this redesign replaces).
    const { container } = render(
      <SpatialEditor
        defaultTool="select"
        canvas={{ nodes: [], edges: [] }}
        onChange={vi.fn()}
        measure={fakeMeasure}
        paletteLeading={<div data-testid="history-slot">history</div>}
      />,
    )
    const palette = container.querySelector('[data-testid="tool-palette"]') as HTMLElement
    expect(palette.querySelector('[data-testid="history-slot"]')).not.toBeNull()
  })
})
