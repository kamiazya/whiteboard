// A canvas whose nodes sit far from the origin opens on them, not on blank paper.
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import '../../index.css'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

it('opens with a far-away node inside the visible canvas', async () => {
  const { container } = render(
    <div className="relative bg-background" style={{ width: 800, height: 600 }}>
      <SpatialEditor
        defaultTool="select"
        canvas={{
          nodes: [
            textNode({ id: 'n1', x: 3000, y: 3000, width: 200, height: 80, text: 'far away' }),
          ],
          edges: [],
        }}
        onChange={vi.fn()}
        theme="light"
        fileRefOptions={[]}
      />
    </div>,
  )
  const host = container.firstElementChild as HTMLElement
  await vi.waitFor(() => {
    const text = screen.getByText('far away')
    const r = text.getBoundingClientRect()
    const h = host.getBoundingClientRect()
    expect(r.right).toBeGreaterThan(h.left)
    expect(r.left).toBeLessThan(h.right)
    expect(r.bottom).toBeGreaterThan(h.top)
    expect(r.top).toBeLessThan(h.bottom)
  })
})
