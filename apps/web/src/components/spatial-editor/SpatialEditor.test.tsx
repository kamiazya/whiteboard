/**
 * jsdom-level coverage for the imperative `SpatialEditorHandle` (no real
 * pointer/layout behavior is under test here — see SpatialEditor.browser.test.tsx
 * for that) and for the `externalVersion`-driven local/external origin
 * distinction on a mid-gesture canvas prop swap.
 */

import { createFixedMeasure } from '@kamiazya/whiteboard-canvas-render/test-utils'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpatialEditorHandle } from '../../lib/spatial/editor-handle.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'
import { SpatialEditor } from './SpatialEditor.js'

const fakeMeasure = createFixedMeasure({ advance: 30, ascent: 10, descent: 2 })

function twoNodeCanvas(): SpatialCanvas {
  return {
    nodes: [
      textNode({ id: 'a', x: 20, y: 20, width: 100, height: 60, text: 'hello' }),
      fileNode({ id: 'b', x: 250, y: 20, width: 80, height: 40, file: 'x.png' }),
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
    const item = getByRole('menuitem', { name: 'Note' })
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

  describe('fitToContent in a measured container', () => {
    const CONTAINER = { width: 800, height: 600 }
    const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')

    // jsdom lays nothing out, so every element reports a 0x0 client box and the
    // editor would frame into a container with no room. Stubbed on the
    // prototype and restored, so the size is a premise of these tests only.
    beforeEach(() => {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
        configurable: true,
        get: () => CONTAINER.width,
      })
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
        configurable: true,
        get: () => CONTAINER.height,
      })
    })
    afterEach(() => {
      if (originalWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalWidth)
      if (originalHeight)
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalHeight)
    })

    function mount(canvas: SpatialCanvas) {
      const ref = createRef<SpatialEditorHandle>()
      const { container } = render(
        <SpatialEditor
          defaultTool="select"
          ref={ref}
          canvas={canvas}
          onChange={vi.fn()}
          measure={fakeMeasure}
        />,
      )
      return { ref, container }
    }

    it('fitToContent(nodeIds) centres only the named nodes in the container', () => {
      const { ref, container } = mount(twoNodeCanvas())

      act(() => {
        ref.current?.fitToContent(['b'])
      })

      // Node "b" spans canvas x 250..330, y 20..60: its centre (290, 40) lands
      // on the container's centre (400, 300), which is the pan Frame selection makes.
      expect(transformOf(container)).toBe('scale(1) translate(110px, 260px)')
    })

    it('fitToContent() with no ids frames every node', () => {
      const { ref, container } = mount(twoNodeCanvas())

      act(() => {
        ref.current?.fitToContent()
      })

      // Both nodes span canvas x 20..330, y 20..80, centred on (175, 50).
      expect(transformOf(container)).toBe('scale(1) translate(225px, 250px)')
    })

    it('fitToContent brings a node far outside the container into view', () => {
      const { ref, container } = mount({
        nodes: [
          textNode({ id: 'near', x: 20, y: 20, width: 100, height: 60, text: 'near' }),
          textNode({ id: 'far', x: 3000, y: 2000, width: 100, height: 60, text: 'far' }),
        ],
        edges: [],
      })

      act(() => {
        ref.current?.fitToContent(['far'])
      })
      // A single box is centred, not pinned to the corner.
      expect(transformOf(container)).toBe('scale(1) translate(-2650px, -1730px)')

      act(() => {
        ref.current?.fitToContent(['near', 'far'])
      })
      // Two boxes 3000px apart cannot both fit at 1:1, so the view must zoom out.
      const match = /scale\(([\d.]+)\) translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(
        transformOf(container) ?? '',
      )
      expect(match).not.toBeNull()
      const [zoom, tx, ty] = [Number(match?.[1]), Number(match?.[2]), Number(match?.[3])]
      expect(zoom).toBeLessThan(1)
      for (const [x, y] of [
        [20, 20],
        [3100, 2060],
      ] as const) {
        const screenX = (x + tx) * zoom
        const screenY = (y + ty) * zoom
        expect(screenX).toBeGreaterThanOrEqual(0)
        expect(screenX).toBeLessThanOrEqual(CONTAINER.width)
        expect(screenY).toBeGreaterThanOrEqual(0)
        expect(screenY).toBeLessThanOrEqual(CONTAINER.height)
      }
    })
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
    // +29/+29 keeps "a" clear of every snap candidate (see the same choice
    // in SpatialEditor.browser.test.tsx), so these tests stay about
    // externalVersion rather than about snapping arithmetic.
    root.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 69, clientY: 69, pointerId: 1 }),
    )
  }
  const DRAG_DROP = { clientX: 69, clientY: 69 }

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
    const root = rootOf(container)
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

    root.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, ...DRAG_DROP, pointerId: 1 }))

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
    const root = rootOf(container)
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

    root.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, ...DRAG_DROP, pointerId: 1 }))

    expect(onChange).toHaveBeenCalledTimes(1)
    const [, command] = onChange.mock.calls[0] as [SpatialCanvas, unknown]
    expect(command).toEqual({ kind: 'move-node', id: 'a', x: 49, y: 49 })
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

describe('paper (ADR-0030)', () => {
  const neon = (): SpatialCanvas => ({
    ...twoNodeCanvas(),
    facets: { 'visual.theme/v0': { theme: 'visual.neon' } },
  })

  it("paints the theme's surface for the UI mode under the canvas, so neon gets its night", () => {
    const { getByTestId } = render(
      <SpatialEditor canvas={neon()} onChange={vi.fn()} measure={fakeMeasure} theme="dark" />,
    )
    expect(getByTestId('spatial-editor').style.backgroundColor).toBe('rgb(3, 7, 17)')
  })

  it('a canvas naming no theme keeps the bundled paper, which is the page background', () => {
    const { getByTestId } = render(
      <SpatialEditor canvas={twoNodeCanvas()} onChange={vi.fn()} measure={fakeMeasure} />,
    )
    expect(getByTestId('spatial-editor').style.backgroundColor).toBe('rgb(255, 255, 255)')
  })
})
