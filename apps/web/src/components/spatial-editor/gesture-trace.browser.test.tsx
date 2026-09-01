/**
 * The flight recorder's wiring: each of the three ways a press can vanish
 * leaves a DIFFERENT trace, and telling them apart is the recorder's whole
 * job — the phone report it exists for is "I pressed and nothing happened",
 * which is one sentence describing three distinct mechanisms.
 *
 * Entries are scoped by a pointerId each test mints, never by counting the
 * singleton's length: the recorder deliberately survives across tests, and
 * an assertion on "the newest entry" would read a neighbour's press as its
 * own (the global-counter flake shape).
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { gestureTrace, type TraceEntry } from './gesture-trace.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const board: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 60, y: 60, width: 200, height: 100, text: 'hello' }],
  edges: [],
}

function Host() {
  const [canvas, setCanvas] = useState(board)
  return (
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor defaultTool="hand" canvas={canvas} onChange={setCanvas} theme="light" />
    </div>
  )
}

function touch(target: Element, type: 'down' | 'move' | 'up', id: number, x: number, y: number) {
  const init = {
    pointerId: id,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    buttons: type === 'up' ? 0 : 1,
    clientX: x,
    clientY: y,
  }
  if (type === 'down') fireEvent.pointerDown(target, init)
  else if (type === 'move') fireEvent.pointerMove(target, init)
  else fireEvent.pointerUp(target, init)
}

function entriesFor(pointerId: number): TraceEntry[] {
  return gestureTrace.entries().filter((entry) => {
    if (entry.kind === 'navigation')
      return 'pointerId' in entry.event && entry.event.pointerId === pointerId
    if (entry.kind === 'reset') return false
    return entry.pointerId === pointerId
  })
}

it('a hand drag records the machine answering: panning, then idle again', () => {
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  const r = root.getBoundingClientRect()
  touch(root, 'down', 71, r.left + 300, r.top + 300)
  touch(root, 'move', 71, r.left + 340, r.top + 320)
  touch(root, 'up', 71, r.left + 340, r.top + 320)

  const modes = entriesFor(71).flatMap((entry) =>
    entry.kind === 'navigation' ? [entry.modeAfter] : [],
  )
  expect(modes).toEqual(['panning', 'panning', 'idle'])
  // The document-side ear heard the same press, headed inside the root.
  const doc = entriesFor(71).filter((entry) => entry.kind === 'doc-pointer')
  expect(doc.map((entry) => (entry.kind === 'doc-pointer' ? entry.insideRoot : false))).toEqual([
    true,
    true,
  ])
})

it('a press the dock takes is recorded with the name of what took it', () => {
  const { container } = render(<Host />)
  const dock = container.querySelector('[aria-label="Canvas tools"]') as HTMLElement
  const b = dock.getBoundingClientRect()
  touch(dock, 'down', 72, b.left + 4, b.top + 4)
  touch(dock, 'up', 72, b.left + 4, b.top + 4)

  const mine = entriesFor(72)
  const rejected = mine.filter((entry) => entry.kind === 'overlay-rejected')
  expect(rejected).toHaveLength(1)
  expect(rejected[0]?.kind === 'overlay-rejected' && rejected[0].target.overlay).toBe(
    'tool-palette',
  )
  // The PRESS never consulted the machine: chrome answers for itself. The
  // release did and should — a release is never overlay-filtered, so a
  // control the press bubbled from still gets its click.
  const consulted = mine.flatMap((entry) => (entry.kind === 'navigation' ? [entry.event.type] : []))
  expect(consulted).toEqual(['pointerup'])
})

it('a press a portal element takes never reaches the editor, and the trace says so', () => {
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  const r = root.getBoundingClientRect()
  const portal = document.createElement('div')
  portal.setAttribute('data-testid', 'trace-test-portal')
  portal.style.cssText = `position:fixed;left:${r.left + 200}px;top:${r.top + 200}px;width:120px;height:120px;z-index:9999`
  document.body.append(portal)
  try {
    touch(portal, 'down', 73, r.left + 240, r.top + 240)
    touch(portal, 'up', 73, r.left + 240, r.top + 240)
  } finally {
    portal.remove()
  }

  const mine = entriesFor(73)
  const doc = mine.filter((entry) => entry.kind === 'doc-pointer' && entry.type === 'pointerdown')
  expect(doc).toHaveLength(1)
  expect(doc[0]?.kind === 'doc-pointer' && doc[0].insideRoot).toBe(false)
  expect(doc[0]?.kind === 'doc-pointer' && doc[0].target.testId).toBe('trace-test-portal')
  // This is the whole discriminator: the document heard it, the editor never did.
  expect(mine.filter((entry) => entry.kind === 'navigation')).toEqual([])
  expect(mine.filter((entry) => entry.kind === 'overlay-rejected')).toEqual([])
})
