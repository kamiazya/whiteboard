// The edge selection is the half of the selection with no reducer behind
// it — eighteen hand-maintained `setSelectedEdgeId` writes — and this pins
// the coherence rule whose absence a user could actually feel: Delete
// answering an edge nobody is looking at any more.
//
// Found by the command-based property's E1 (see
// editor-state.property.test.ts). Its sibling E2 — the selected edge still
// exists — is fixed there too, but ONLY the property guards that one: with
// E1 held, no sequence was found in which a stale edge selection changes
// what the user sees or what a verb does, so any browser test for it would
// pass with the fix reverted. A guard that cannot fail is worse than none,
// because it reads as coverage.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { rootOf } from '../../test-utils/spatial-editor-root.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const start: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 100, y: 100, width: 120, height: 60, text: 'A' },
    { id: 'b', type: 'text', x: 400, y: 100, width: 120, height: 60, text: 'B' },
  ],
  edges: [{ id: 'e0', fromNode: 'a', toNode: 'b' }],
}

let latest: SpatialCanvas = start

function Host() {
  const [canvas, setCanvas] = useState<SpatialCanvas>(start)
  latest = canvas
  return (
    <div style={{ width: 900, height: 600 }}>
      <SpatialEditor
        defaultTool="select"
        canvas={canvas}
        onChange={(next) => setCanvas(next)}
        theme="light"
      />
    </div>
  )
}

/**
 * Presses the midpoint of the rendered a→b edge. Derived from the drawn
 * polyline rather than hardcoded, so routing changes cannot silently move
 * the press off the line and turn this into an empty-space click.
 */
async function pressEdge(container: HTMLElement) {
  const root = rootOf(container)
  const polyline = await vi.waitFor(() => {
    const el = container.querySelector('[data-testid="spatial-editor"] svg polyline')
    expect(el).not.toBeNull()
    return el as SVGPolylineElement
  })
  const edgeRect = polyline.getBoundingClientRect()
  const base = {
    bubbles: true,
    clientX: edgeRect.x + edgeRect.width / 2,
    clientY: edgeRect.y + edgeRect.height / 2,
    pointerId: 7,
  }
  root.dispatchEvent(new PointerEvent('pointerdown', { ...base, button: 0 }))
  root.dispatchEvent(new PointerEvent('pointerup', base))
}

it('a note added while an edge was selected is what Delete then removes', async () => {
  const { container } = render(<Host />)
  const root = rootOf(container)

  await pressEdge(container)
  await vi.waitFor(() => {
    expect(container.querySelector('[data-testid="edge-selection-highlight"]')).not.toBeNull()
  })

  // The PALETTE path, not a double-click on the canvas: an empty-space
  // press clears the edge selection on its way past, so the double-click
  // route would make this test pass without the rule it pins. `Add` never
  // presses the canvas — which is exactly why the omission survived there.
  await userEvent.click(screen.getByRole('button', { name: 'Add' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Note' }))
  const editor = await screen.findByRole('textbox')
  // Blur commits and leaves the gesture idle. Escape would not do: its
  // first branch clears the edge selection and returns.
  fireEvent.blur(editor)
  await vi.waitFor(() => expect(screen.queryByRole('textbox')).toBeNull())

  root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))

  // Delete answers a selected EDGE before the node selection, so with both
  // set it takes the edge the user stopped looking at three actions ago
  // and leaves the note they are looking at.
  await vi.waitFor(() => {
    expect(latest.nodes.map((n) => n.id)).toEqual(['a', 'b'])
  })
  expect(latest.edges.map((e) => e.id)).toEqual(['e0'])
})
