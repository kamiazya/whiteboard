// LOD auto-expansion for canvas embeds (embed spec v2): a file node whose
// on-screen box is large enough renders the referenced canvas as an inline
// miniature; smaller ones stay cards. The decision follows zoom — zooming
// out far enough collapses the miniature back to a card (hysteresis keeps
// the boundary from flickering).
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { rootOf } from '../../test-utils/spatial-editor-root.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const referenced: SpatialCanvas = {
  nodes: [
    { id: 'r1', type: 'text', x: 0, y: 0, width: 300, height: 150, text: 'inside' },
    { id: 'r2', type: 'text', x: 400, y: 0, width: 200, height: 100, text: 'more' },
  ],
  edges: [],
}

function makeHost(initial: SpatialCanvas) {
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(initial)
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          onChange={(next) => setCanvas(next)}
          theme="light"
          fileRefOptions={[{ file: 'ref-1', label: 'Referenced canvas' }]}
          resolveReference={(ref) => (ref === 'ref-1' ? { canvas: referenced } : undefined)}
        />
      </div>
    )
  }
  return Host
}

function embeddedTextExists(container: HTMLElement): boolean {
  return (container.textContent ?? '').includes('inside')
}

it('a large file node renders the referenced canvas inline; a small one stays a card', async () => {
  const large: SpatialCanvas = {
    nodes: [{ id: 'big', type: 'file', x: 60, y: 60, width: 320, height: 240, file: 'ref-1' }],
    edges: [],
  }
  const Host = makeHost(large)
  const { container } = render(<Host />)
  await vi.waitFor(() => expect(embeddedTextExists(container)).toBe(true))

  cleanup()

  const small: SpatialCanvas = {
    nodes: [{ id: 'tiny', type: 'file', x: 60, y: 60, width: 120, height: 80, file: 'ref-1' }],
    edges: [],
  }
  const SmallHost = makeHost(small)
  const { container: smallContainer } = render(<SmallHost />)
  // Below the expand threshold: the card (resolved label) renders, not the
  // referenced content.
  expect(embeddedTextExists(smallContainer)).toBe(false)
  // A 120px-wide card cannot hold the whole resolved name, so the label is cut
  // to a prefix and faded rather than painted past the border. What matters
  // here is that the CARD rendered at all.
  expect('Referenced canvas'.startsWith(smallContainer.textContent ?? '')).toBe(true)
  expect(smallContainer.textContent?.length ?? 0).toBeGreaterThan(0)
})

it('zooming far out collapses an expanded miniature back to the card', async () => {
  const large: SpatialCanvas = {
    nodes: [{ id: 'big', type: 'file', x: 300, y: 220, width: 320, height: 240, file: 'ref-1' }],
    edges: [],
  }
  const Host = makeHost(large)
  const { container } = render(<Host />)
  const root = rootOf(container)
  await vi.waitFor(() => expect(embeddedTextExists(container)).toBe(true))

  // Wheel-zoom out until the node's on-screen box is far below the
  // collapse threshold (320px * 0.3 < 160px).
  for (let i = 0; i < 14; i += 1) {
    fireEvent.wheel(root, { deltaY: 120, ctrlKey: true, clientX: 400, clientY: 300 })
  }
  await vi.waitFor(() => expect(embeddedTextExists(container)).toBe(false))
})
