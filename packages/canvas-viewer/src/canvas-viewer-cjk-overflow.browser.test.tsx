// A real-browser lock on "a text node's body never paints below its frame",
// for the case only a real browser can produce: CJK measured by an actual
// Canvas 2D backend. `fake-measure.ts` charges every character 0.6em, which
// understates Japanese by ~40% and is enough to hide the extra wrapped line
// that pushes a paragraph out of the box — so the node-project test for this
// has to simulate full-width advances, and this file is what proves the
// simulation matches a browser.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CanvasViewer } from './CanvasViewer.js'
import { ensureViewerFontLoaded } from './font-loading.js'
import { createBrowserMeasureText } from './measure-text.js'

// The node as it was reported from the running app: a box too small for the
// wrapped body, whose last paragraph painted outside the frame entirely.
const REPORTED: SpatialCanvas = {
  nodes: [
    {
      id: '81d6a81f-cd39-4d81-87c6-77465473a3b9',
      type: 'text',
      x: 40,
      y: 260,
      width: 67,
      height: 51,
      text: 'かあらた\n\nかたそ',
    },
  ],
  edges: [],
}

const NODE_BOTTOM = 260 + 51

describe('a text node with CJK prose (real browser)', () => {
  it('paints no text below its own frame', async () => {
    await ensureViewerFontLoaded()
    const { container } = render(
      <CanvasViewer canvas={REPORTED} measure={createBrowserMeasureText()} />,
    )

    await expect.poll(() => container.querySelector('svg')).toBeTruthy()
    const texts = [...(container.querySelectorAll('svg text') ?? [])]
    expect(texts.length).toBeGreaterThan(0)

    // `y` on a <text> is its BASELINE, so descenders sit below it; the frame
    // bottom is the bound that matters and the baseline must clear it.
    for (const text of texts) {
      const y = Number(text.getAttribute('y'))
      expect(Number.isFinite(y)).toBe(true)
      expect(y).toBeLessThanOrEqual(NODE_BOTTOM)
    }
  })
})
