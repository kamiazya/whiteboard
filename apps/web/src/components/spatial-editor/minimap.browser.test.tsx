// The minimap in the editor. Fitting geometry is unit-tested in
// minimap.test.ts; this pins the wiring: when it appears, that pressing it
// centres the canvas, and that it gets out of the way of a gesture.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const spread: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 60, text: 'A' },
    { id: 'b', type: 'text', x: 2000, y: 1200, width: 100, height: 60, text: 'B' },
  ],
  edges: [],
}

function Host({ canvas0 }: { canvas0: SpatialCanvas }) {
  const [canvas, setCanvas] = useState(canvas0)
  return (
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor
        defaultTool="select"
        canvas={canvas}
        onChange={(next) => setCanvas(next)}
        theme="light"
      />
    </div>
  )
}

const minimapOf = (c: HTMLElement) =>
  c.querySelector('[data-testid="minimap"]') as HTMLElement | null
const transformOf = (c: HTMLElement) =>
  c.querySelector<HTMLDivElement>('[data-testid="viewport-transform"]')?.style.transform
const editorOf = (c: HTMLElement) =>
  c.querySelector('[data-testid="spatial-editor"]') as HTMLElement

it('shows an overview once the canvas has content', () => {
  const { container } = render(<Host canvas0={spread} />)
  expect(minimapOf(container)).toBeTruthy()
  expect(container.querySelector('[data-testid="minimap-viewport"]')).toBeTruthy()
})

it('stays away on an empty canvas, where an overview has no job', () => {
  const { container } = render(<Host canvas0={{ nodes: [], edges: [] }} />)
  expect(minimapOf(container)).toBeNull()
})

// The scene is an <svg> and callers reach for it with container-wide
// selectors; a second SVG here would answer for it.
it('adds no <svg> of its own, so scene queries still find only the scene', () => {
  const { container } = render(<Host canvas0={spread} />)
  const before = container.querySelectorAll('svg').length
  expect(minimapOf(container)).toBeTruthy()
  expect(container.querySelectorAll('svg').length).toBe(before)
  expect(minimapOf(container)?.querySelector('svg')).toBeNull()
})

it('centres the canvas on the point that was pressed', () => {
  const { container } = render(<Host canvas0={spread} />)
  const minimap = minimapOf(container)!
  const before = transformOf(container)
  const rect = minimap.getBoundingClientRect()

  fireEvent.pointerDown(minimap, {
    clientX: rect.left + rect.width - 4,
    clientY: rect.top + rect.height - 4,
  })

  const after = transformOf(container)
  expect(after).not.toBe(before)
  // Panning toward positive canvas coordinates translates NEGATIVELY.
  const translate = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(after ?? '')
  expect(translate, `unexpected transform ${after}`).toBeTruthy()
  expect(Number(translate?.[1])).toBeLessThan(0)
  expect(Number(translate?.[2])).toBeLessThan(0)
})

it('does not move the viewport on a bare hover', () => {
  const { container } = render(<Host canvas0={spread} />)
  const minimap = minimapOf(container)!
  const before = transformOf(container)
  const rect = minimap.getBoundingClientRect()

  fireEvent.pointerMove(minimap, {
    clientX: rect.left + rect.width - 4,
    clientY: rect.top + rect.height - 4,
    buttons: 0,
  })

  expect(transformOf(container)).toBe(before)
})

// It stays up during a drag now: data-editor-overlay stops a press on it
// reaching the canvas, so hiding bought nothing and flickered every gesture.
it('stays visible while a gesture is in flight', () => {
  const { container } = render(<Host canvas0={spread} />)
  const editor = editorOf(container)
  const r = editor.getBoundingClientRect()

  fireEvent.pointerDown(editor, {
    button: 0,
    pointerId: 1,
    clientX: r.left + 50,
    clientY: r.top + 30,
  })
  fireEvent.pointerMove(editor, { pointerId: 1, clientX: r.left + 300, clientY: r.top + 200 })
  expect(minimapOf(container)).toBeTruthy()

  fireEvent.pointerUp(editor, { pointerId: 1, clientX: r.left + 300, clientY: r.top + 200 })
  expect(minimapOf(container)).toBeTruthy()
})

// The editor root treats a press outside an opted-in overlay as canvas, so
// without data-editor-overlay a minimap press ALSO starts a marquee (Select)
// or a pan (Hand) underneath the navigation.
it('navigates without starting a canvas gesture underneath', () => {
  const { container } = render(<Host canvas0={spread} />)
  const minimap = minimapOf(container)!
  const rect = minimap.getBoundingClientRect()

  fireEvent.pointerDown(minimap, {
    button: 0,
    pointerId: 9,
    clientX: rect.left + 20,
    clientY: rect.top + 20,
  })

  // A marquee would have started a gesture, which hides the minimap.
  expect(minimapOf(container)).toBeTruthy()
  expect(container.querySelector('[data-testid="marquee-rect"]')).toBeNull()
})

// The reason the size comes from a ResizeObserver and not a window `resize`
// listener: the container can change size without the window doing so, and a
// marker that lags that is wrong about where you are.
it('tracks a container resize that the window never sees', async () => {
  const { container } = render(<Host canvas0={spread} />)
  const host = container.firstElementChild as HTMLElement
  const markerWidth = () =>
    (container.querySelector('[data-testid="minimap-viewport"]') as HTMLElement).style.width

  const before = markerWidth()
  host.style.width = '400px'

  await vi.waitFor(() => {
    expect(markerWidth()).not.toBe(before)
  })
})
