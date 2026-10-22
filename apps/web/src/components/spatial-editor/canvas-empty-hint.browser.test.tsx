// An empty canvas names its way in, per pointer, and the cue goes once there
// is a node. Real browser: the copy turns on matchMedia and the hint must not
// sit in front of the dock or catch presses.
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '../../index.css'
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

function mount(nodes: Parameters<typeof SpatialEditor>[0]['canvas']['nodes']) {
  return render(
    <div className="relative bg-background" style={{ width: 390, height: 600 }}>
      <SpatialEditor
        defaultTool="select"
        canvas={{ nodes, edges: [] }}
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

it('an empty canvas on a fine pointer says to double-click', () => {
  coarse = false
  mount([])
  expect(screen.getByTestId('canvas-empty-hint').textContent).toBe('Double-click to add a note')
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
