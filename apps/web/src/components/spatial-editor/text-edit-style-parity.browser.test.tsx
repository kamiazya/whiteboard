// The text-edit overlay covers the node's rendered chrome; its box styling
// must come from the SAME theme producers the SVG render uses, not
// hand-restated values that drift when the theme changes. (The wrapping
// engines still differ — CSS vs the injected measurer — a documented
// ceiling, not pinned here.)

import {
  BODY_FONT_SIZE_PX,
  BODY_LINE_HEIGHT_PX,
  SPATIAL_THEME_GEOMETRY,
} from '@kamiazya/whiteboard-canvas-render'
import { withViewerFontEmbedded } from '@kamiazya/whiteboard-canvas-viewer'
import { registerFontBytes } from '@kamiazya/whiteboard-canvas-viewer/font-loading'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { nodeEditor } from './node-editor-test-utils.js'
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

function Host({ initial = start }: { initial?: SpatialCanvas }) {
  const [canvas, setCanvas] = useState<SpatialCanvas>(initial)
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
  const editor = await vi.waitFor(() => {
    const el = nodeEditor(container)
    expect(el).not.toBeNull()
    return el as HTMLElement
  })
  // No painted chrome of its own any more: the scene draws the node's
  // chrome and the editor is transparent, so radius parity retired with the
  // opaque background. The METRIC parity below is still load-bearing.
  expect(editor.style.background).toBe('transparent')
  expect(editor.style.padding).toBe(`${SPATIAL_THEME_GEOMETRY.paddingPx}px`)
  // The overlay advances by the same LINE BOX the committed render uses
  // (mdast-blocks' `BODY_LINE_HEIGHT_PX`), which is what stops the text
  // moving under the cursor when someone double-clicks a node. This
  // assertion is why that defect never shipped: it was written when the two
  // constants were equal and caught the moment they stopped being.
  expect(editor.style.lineHeight).toBe(`${BODY_LINE_HEIGHT_PX}px`)
  expect(editor.style.fontSize).toBe(`${BODY_FONT_SIZE_PX}px`)
})

it('the edit overlay is typed in the theme family once its face is held, like the render', async () => {
  // The family the scene DECLARES is the one the overlay types in: with the
  // face held this realm declares the theme's, and the draft must not jump
  // to another hand on commit. Any real font file will do for the face set;
  // the vendored one is registered under the family the sketch theme names.
  const embedded = await withViewerFontEmbedded('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  const uri = /src:url\('(data:font\/ttf;base64,[^']+)'\)/.exec(embedded)?.[1] as string
  await registerFontBytes('Yomogi', await (await fetch(uri)).arrayBuffer())

  const sketched: SpatialCanvas = {
    ...start,
    facets: { 'visual.theme/v0': { theme: 'visual.sketch' } },
  }
  const { container } = render(<Host initial={sketched} />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  await userEvent.dblClick(root, { position: { x: 200, y: 150 } })
  const editor = await vi.waitFor(() => {
    const el = nodeEditor(container)
    expect(el).not.toBeNull()
    return el as HTMLElement
  })
  expect(editor.style.fontFamily).toBe('Yomogi')
})
