// The minimap in the editor. Fitting geometry is unit-tested in
// minimap.test.ts; this pins the wiring: when it appears, that pressing it
// centres the canvas, and that it gets out of the way of a gesture.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const spread: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 0, y: 0, width: 100, height: 60, text: 'A' }),
    textNode({ id: 'b', x: 2000, y: 1200, width: 100, height: 60, text: 'B' }),
  ],
  edges: [],
}

function Host({ canvas0, width = 800 }: { canvas0: SpatialCanvas; width?: number }) {
  const [canvas, setCanvas] = useState(canvas0)
  return (
    <div style={{ width, height: 600 }}>
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

// Both the overview and the dock are bottom-anchored inside the SAME
// container, and the dock is centred and grows to ~380px on touch. Below
// roughly 730px of container they overlap. The predicate is the container's
// width, not the viewport's: a narrow editor column on a wide screen collides
// exactly the same way, and a media query would miss it.
it('stays away when the editor is too narrow to hold it beside the dock', () => {
  const { container } = render(<Host canvas0={spread} width={390} />)
  expect(minimapOf(container)).toBeNull()
})

it('comes back when the editor is widened past that point', async () => {
  const { container } = render(<Host canvas0={spread} width={390} />)
  const host = container.firstElementChild as HTMLElement
  expect(minimapOf(container)).toBeNull()

  host.style.width = '1000px'

  await vi.waitFor(() => {
    expect(minimapOf(container)).toBeTruthy()
  })
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
  // Stays above the width at which the overview yields to the dock — this
  // test is about tracking a resize, not about the yield threshold.
  host.style.width = '1200px'

  await vi.waitFor(() => {
    expect(markerWidth()).not.toBe(before)
  })
})

// An overview too small to read labels in needs colour to be findable at
// all, and it has to be the SAME accent the scene uses or it points at the
// wrong node.
it('paints an authored preset colour, and leaves an unstyled node muted', () => {
  const coloured: SpatialCanvas = {
    nodes: [
      textNode({ id: 'a', x: 0, y: 0, width: 100, height: 60, text: 'A', color: '1' }),
      textNode({ id: 'b', x: 400, y: 400, width: 100, height: 60, text: 'B' }),
      textNode({ id: 'c', x: 800, y: 800, width: 100, height: 60, text: 'C', color: '#123456' }),
    ],
    edges: [],
  }
  const { container } = render(<Host canvas0={coloured} />)
  const blocks = [...minimapOf(container)!.querySelectorAll('div')].filter(
    (el) => el.getAttribute('data-testid') !== 'minimap-viewport',
  )

  // Preset '1' is the light palette's red accent; the hex passes through;
  // the unstyled node paints nothing of its own.
  expect(blocks[0]?.style.background).toBe('rgb(220, 38, 38)')
  expect(blocks[1]?.style.background).toBe('')
  expect(blocks[2]?.style.background).toBe('rgb(18, 52, 86)')
})

// Without a stacking context the scene paints over the overview: it is
// later in the DOM and its nodes are positioned, so document order wins.
it('sits above the canvas scene', () => {
  const { container } = render(<Host canvas0={spread} />)
  expect(getComputedStyle(minimapOf(container)!).zIndex).not.toBe('auto')
})

// The overview is the surface `visual.symbol` was built for: a node here is
// a few pixels, so the box says WHERE and the mark says WHICH.
const marked = (width: number): SpatialCanvas => ({
  nodes: [
    {
      id: 'a',
      type: 'text',
      x: 0,
      y: 0,
      width,
      height: width,
      text: 'A',
      facets: { 'visual.symbol/v0': { kind: 'emoji', char: '📌' } },
    },
    textNode({ id: 'b', x: 4000, y: 4000, width: 100, height: 60, text: 'B' }),
  ],
  edges: [],
})

it("draws a node's symbol in the overview once its box is big enough to hold one", () => {
  // A node occupying most of the fitted bounds projects well past the
  // threshold.
  const { container } = render(<Host canvas0={marked(3000)} />)
  expect(container.querySelector('[data-testid="minimap-symbol"]')).toBeTruthy()
})

it('leaves a box too small for a mark as a plain box', () => {
  // The same document, with the marked node small enough that its projected
  // box is a few pixels: a symbol drawn there is dirt on the box, not a
  // mark, so the overview keeps what it had.
  const { container } = render(<Host canvas0={marked(40)} />)
  expect(container.querySelector('[data-testid="minimap"]')).toBeTruthy()
  expect(container.querySelector('[data-testid="minimap-symbol"]')).toBeNull()
})

// The mark is ONE size whatever box it lands in, the same rule the full-size
// badge follows on a node of any size. Scaling it with the box made the mark
// a ranking of node areas rather than a statement of identity — measured at
// 20.9px and 31.4px in one overview — and at 0.8 of the short side it also
// left the box's own colour, which is what the overview is FOR, as a rim.
const twoMarked: SpatialCanvas = {
  nodes: [
    textNode({
      id: 'big',
      x: 0,
      y: 0,
      width: 1400,
      height: 900,
      text: 'A',
      facets: { 'visual.symbol/v0': { kind: 'emoji', char: '📌' } },
    }),
    textNode({
      id: 'small',
      x: 2000,
      y: 0,
      width: 600,
      height: 600,
      text: 'B',
      facets: { 'visual.symbol/v0': { kind: 'emoji', char: '⭐' } },
    }),
  ],
  edges: [],
}

it('draws every mark in the overview at one size, whatever box it sits in', () => {
  const { container } = render(<Host canvas0={twoMarked} />)
  const marks = [...container.querySelectorAll('[data-testid="minimap-symbol"]')]
  expect(marks.length).toBe(2)
  const sizes = marks.map((mark) => mark.getBoundingClientRect().width)
  expect(sizes[1]).toBeCloseTo(sizes[0] as number, 1)
})

it('leaves the box it marks still visible around the mark', () => {
  // The box carries WHERE and its authored colour; the mark adds WHICH. A
  // glyph at 80% of the short side reduced the first to a rim.
  const { container } = render(<Host canvas0={twoMarked} />)
  const mark = container.querySelector('[data-testid="minimap-symbol"]') as HTMLElement
  const box = mark.parentElement as HTMLElement
  const shortSide = Math.min(box.getBoundingClientRect().width, box.getBoundingClientRect().height)
  expect(mark.getBoundingClientRect().width).toBeLessThan(shortSide * 0.5)
})
