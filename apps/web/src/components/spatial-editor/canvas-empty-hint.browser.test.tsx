// An empty canvas names its way in, per pointer, and the cue goes once there
// is a node. Real browser: the copy turns on matchMedia and the hint must not
// sit in front of the dock or catch presses.
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '../../index.css'
import { freehandLine } from '../../lib/spatial/freehand.js'
import { SpatialEditor } from './SpatialEditor.js'

const realMatchMedia = window.matchMedia
let coarse = true

beforeEach(() => {
  window.matchMedia = (query: string) =>
    query === '(pointer: coarse)'
      ? ({ matches: coarse, media: query } as MediaQueryList)
      : realMatchMedia.call(window, query)
})

afterEach(() => {
  cleanup()
  window.matchMedia = realMatchMedia
})

type Canvas = Parameters<typeof SpatialEditor>[0]['canvas']

function mount(nodes: Canvas['nodes'], lines?: Canvas['lines']) {
  return render(
    <div className="relative bg-background" style={{ width: 390, height: 600 }}>
      <SpatialEditor
        defaultTool="select"
        canvas={{ nodes, edges: [], ...(lines === undefined ? {} : { lines }) }}
        onChange={vi.fn()}
        theme="light"
        fileRefOptions={[]}
      />
    </div>,
  )
}

it('an empty canvas on a coarse pointer says to tap +', () => {
  coarse = true
  mount([])
  expect(screen.getByTestId('canvas-empty-hint').textContent).toBe('Tap + to add a note')
})

it('an empty canvas on a fine pointer says to double-click or press N', () => {
  coarse = false
  mount([])
  expect(screen.getByTestId('canvas-empty-hint').textContent).toBe(
    'Double-click or press N to add a note',
  )
})

it('the hint never catches a press meant for the canvas', () => {
  coarse = true
  mount([])
  expect(getComputedStyle(screen.getByTestId('canvas-empty-hint')).pointerEvents).toBe('none')
})

it('the hint is gone once the canvas has a node', () => {
  coarse = true
  mount([textNode({ id: 'n1', x: 20, y: 20, width: 200, height: 80, text: 'hello' })])
  expect(screen.queryByTestId('canvas-empty-hint')).toBeNull()
})

it('a canvas holding only a drawing is not empty and draws no hint', () => {
  coarse = true
  const loop = freehandLine(
    'ink-1',
    [
      { x: 60, y: 60 },
      { x: 160, y: 40 },
      { x: 200, y: 140 },
      { x: 80, y: 160 },
    ],
    1,
  )
  if (loop === undefined) throw new Error('the fixture stroke was refused')
  mount([], [loop])
  expect(screen.queryByTestId('canvas-empty-hint')).toBeNull()
  const canvas = screen.getByRole('application')
  expect(canvas.getAttribute('aria-label')).toBe('Canvas, 1 drawing. Tab selects the first drawing')
  expect(canvas.hasAttribute('aria-describedby')).toBe(false)
})
