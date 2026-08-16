// The text-edit overlay covers the node's rendered chrome; its box styling
// must come from the SAME theme producers the SVG render uses, not
// hand-restated values that drift when the theme changes. (The wrapping
// engines still differ — CSS vs the injected measurer — a documented
// ceiling, not pinned here.)

import { BODY_FONT_SIZE_PX, SPATIAL_THEME_GEOMETRY } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { createEditorAppearance } from './editor-appearance.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const node = {
  id: 'n1',
  type: 'text' as const,
  x: 100,
  y: 100,
  width: 200,
  height: 100,
  text: 'hello world',
}
const start: SpatialCanvas = { nodes: [node], edges: [] }

function Host() {
  const [canvas, setCanvas] = useState<SpatialCanvas>(start)
  return (
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor defaultTool="select" canvas={canvas} onChange={setCanvas} theme="light" />
    </div>
  )
}

it('the edit overlay box styling equals the rendered chrome (shared theme producers)', async () => {
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  await userEvent.dblClick(root, { position: { x: 200, y: 150 } })
  const textarea = await vi.waitFor(() => {
    const el = container.querySelector('textarea')
    expect(el).not.toBeNull()
    return el as HTMLTextAreaElement
  })
  const resolved = createEditorAppearance('light').resolveNode(node)
  expect(textarea.style.borderRadius).toBe(`${resolved.radius}px`)
  expect(textarea.style.padding).toBe(`${SPATIAL_THEME_GEOMETRY.paddingPx}px`)
  // The rendered layout advances one font-size per line (mdast-blocks);
  // the overlay's line height restates that invariant.
  expect(textarea.style.lineHeight).toBe(`${BODY_FONT_SIZE_PX}px`)
  expect(textarea.style.fontSize).toBe(`${BODY_FONT_SIZE_PX}px`)
})
