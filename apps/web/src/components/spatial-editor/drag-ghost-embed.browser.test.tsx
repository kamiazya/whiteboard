import { referenceSeams } from '@kamiazya/whiteboard-canvas-render'
// The drag ghost renders the carried node's REAL content — including an
// expanded canvas embed. Omitting the embed resolvers from the ghost's
// one-shot render made an inline miniature drag as a plain card and snap
// back to a miniature on drop.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const inner: SpatialCanvas = {
  nodes: [{ id: 'i1', type: 'text', x: 0, y: 0, width: 200, height: 100, text: 'inner content' }],
  edges: [],
}

const outer: SpatialCanvas = {
  nodes: [
    {
      id: 'f1',
      type: 'file',
      x: 100,
      y: 100,
      width: 320,
      height: 300,
      file: 'child',
    },
  ],
  edges: [],
}

function press(el: HTMLElement, type: string, x: number, y: number) {
  const r = el.getBoundingClientRect()
  return el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      clientX: r.left + x,
      clientY: r.top + y,
      pointerId: 7,
      button: 0,
    }),
  )
}

it('drags an expanded embed with its miniature content in the ghost', async () => {
  const { container } = render(
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor
        defaultTool="select"
        canvas={outer}
        onChange={() => {}}
        theme="light"
        fileRefOptions={[{ file: 'child', label: 'child canvas' }]}
        references={referenceSeams(new Map(), {
          extra: (ref) => (ref === 'child' ? { canvas: inner } : undefined),
        })}
      />
    </div>,
  )
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  // The committed render expands the embed (large on-screen node).
  await vi.waitFor(() => {
    expect((container.textContent ?? '').includes('inner content')).toBe(true)
  })

  press(root, 'pointerdown', 260, 250)
  await new Promise((r) => requestAnimationFrame(r))
  press(root, 'pointermove', 300, 290)
  await vi.waitFor(() => {
    const preview = container.querySelector('[data-testid="drag-preview"]')
    expect(preview).not.toBeNull()
    // The ghost carries the embedded miniature, not a bare card.
    expect(preview?.innerHTML ?? '').toContain('inner content')
  })
  press(root, 'pointerup', 300, 290)
})
