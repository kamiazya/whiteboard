// DOCUMENTED CEILING: the CSS textarea overlay and the committed render's
// injected-measure layout (mdast-blocks.ts) are two independent wrap
// engines over the SAME content width (nodeWidth - 2*paddingPx) — CSS shapes
// whole line boxes (kerning across word+space), the measurer sums per-word
// advances (packages/canvas-render/src/measure.ts). This test pins their
// CURRENT relationship for one canonical fixture; it does NOT unify them
// (see text-edit-style-parity.browser.test.tsx's header, which names the
// same divergence and defers pinning it to here).
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { BODY_FONT_SIZE_PX, SPATIAL_THEME_GEOMETRY } from '@kamiazya/whiteboard-canvas-render'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

// A single repeated word, not a natural sentence: every wrap point falls at
// the same word-boundary offset, so the fixture's line count is decided by
// how many "wrap " advances (~4 chars + space) fit in the 184px content
// width (200 - 2*8), several px away from the next word's boundary — font
// fallback/kerning variance cannot flip a line count this discrete.
const WRAPPING_TEXT = Array(24).fill('wrap').join(' ')

const node = {
  id: 'n1',
  type: 'text' as const,
  x: 100,
  y: 100,
  width: 200,
  // Deliberately shorter than the wrapped content: the overlay textarea's
  // box.height comes straight from the node's authored height (not
  // recomputed from content), and scrollHeight only reports the FULL
  // unclipped content height once the box is too short to contain it —
  // otherwise scrollHeight clamps to clientHeight regardless of how little
  // text there is.
  height: 20,
  text: WRAPPING_TEXT,
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

it('pins the CSS-vs-injected-measure wrap-line-count relationship for a canonical fixture', async () => {
  const { container } = render(<Host />)

  // Committed render: count distinct baseline `y` values among the injected
  // SVG's <text> elements BEFORE opening the overlay (entering edit mode
  // must not change what this measures).
  const contentHost = container.querySelector('[data-testid="canvas-content"]') as HTMLElement
  const svgTexts = [...contentHost.querySelectorAll('svg text')]
  const svgLineYs = new Set(svgTexts.map((el) => el.getAttribute('y')))
  const svgLineCount = svgLineYs.size
  // Non-vacuity: the fixture must actually wrap, or the pin below holds
  // trivially on an unwrapped single line.
  expect(svgLineCount).toBeGreaterThanOrEqual(4)

  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  await userEvent.dblClick(root, { position: { x: 200, y: 110 } })
  const textarea = await vi.waitFor(() => {
    const el = container.querySelector('textarea')
    expect(el).not.toBeNull()
    return el as HTMLTextAreaElement
  })

  // CSS engine: derive the wrapped line count from scrollHeight using the
  // SAME shared constants the overlay is styled with (never the element's
  // own computed lineHeight/fontSize — that would make the mutation check
  // below vacuous, since a lineHeight/fontSize change would just silently
  // relabel itself).
  const contentHeight = textarea.scrollHeight - 2 * SPATIAL_THEME_GEOMETRY.paddingPx
  const cssLineCountRaw = contentHeight / BODY_FONT_SIZE_PX
  // Non-vacuity: must divide out to a whole number of lines using the
  // shared constants, or the arithmetic itself is wrong for this fixture.
  expect(Math.abs(cssLineCountRaw - Math.round(cssLineCountRaw))).toBeLessThan(0.01)
  const cssLineCount = Math.round(cssLineCountRaw)
  expect(cssLineCount).toBeGreaterThanOrEqual(4)

  // The pin: for this fixture, the CSS engine and the injected-measure
  // engine agree exactly. This is the observed relationship, not an a
  // priori guarantee of the two engines — see the ceiling comment above.
  expect(cssLineCount).toBe(svgLineCount)
})
