// A node whose silhouette comes from `visual.shape` must KEEP that
// silhouette while its text is edited. The editor overlay used to be an
// opaque rectangle painted over the whole bbox — the one cover that erases
// a non-rectangular node for the duration of the edit — so the scene now
// keeps drawing the chrome and suppresses only the edited node's text
// (canvas-render's `suppressedBodyNodeIds`), and the overlay is transparent.
import { ensureViewerFontLoaded } from '@kamiazya/whiteboard-canvas-viewer'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { rootOf } from '../../test-utils/spatial-editor-root.js'
import { nodeEditorContent } from './node-editor-test-utils.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

// SpatialEditor never awaits font readiness itself (unlike CanvasViewer,
// it has no subscribeViewerFontReady re-measure) — the app's real guarantee
// is boot.ts awaiting this before the first render. Without it here, the
// very first layout measures against whatever "Roboto" resolves to on this
// machine (a real system Roboto, a metric-different substitute, or nothing)
// instead of the vendored face every other measurement in the app agrees on.
beforeAll(async () => {
  await ensureViewerFontLoaded()
})

// The diamond's inscribed content box is only half the node's width (see
// the contentBox comment below), so at the label font size (16px) the real
// vendored Roboto face — the one every on-screen measurement in the app
// agrees on, per beforeAll above — measures a 10-character word like
// 'shapedbody' at ~86px against an 84px box: an unforced, environment-
// dependent truncation that has nothing to do with the behavior under test.
// 'shapefit' measures ~58px, leaving margin.
const DIAMOND: SpatialCanvas = {
  nodes: [
    {
      id: 'n1',
      type: 'text',
      x: 100,
      y: 100,
      width: 200,
      height: 100,
      text: 'shapefit',
      'x-whiteboard': { facets: { 'visual.shape/v0': { kind: 'diamond' } } },
    },
  ],
  edges: [],
}

function Host({ start }: { start: SpatialCanvas }) {
  const [canvas, setCanvas] = useState<SpatialCanvas>(start)
  return (
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor
        defaultTool="select"
        canvas={canvas}
        onChange={(next) => setCanvas(next)}
        theme="light"
      />
    </div>
  )
}

/** The committed scene's text content — the SVG's, never the editor's. */
function svgText(container: HTMLElement): string {
  return [...container.querySelectorAll('svg')].map((svg) => svg.textContent ?? '').join(' ')
}

it('keeps the diamond silhouette on screen while its text is being edited', async () => {
  const { container } = render(<Host start={DIAMOND} />)
  expect(container.querySelector('svg polygon')).not.toBeNull()
  expect(svgText(container)).toContain('shapefit')

  await userEvent.dblClick(rootOf(container), { position: { x: 200, y: 150 } })
  await vi.waitFor(() => expect(nodeEditorContent(container)).not.toBeNull())

  // The silhouette still draws; only the committed text yields to the editor.
  expect(container.querySelector('svg polygon')).not.toBeNull()
  await vi.waitFor(() => expect(svgText(container)).not.toContain('shapefit'))
})

it("the editor sits in the diamond's inscribed content box, not the full bbox", async () => {
  const { container } = render(<Host start={DIAMOND} />)
  await userEvent.dblClick(rootOf(container), { position: { x: 200, y: 150 } })
  await vi.waitFor(() => expect(nodeEditorContent(container)).not.toBeNull())

  const host = container.querySelector('[data-testid="text-node-editor"]') as HTMLElement
  // visual.diamond's contentBox: the maximal inscribed rect (x+w/4, y+h/4, w/2, h/2).
  expect(host.style.left).toBe('150px')
  expect(host.style.top).toBe('125px')
  expect(host.style.width).toBe('100px')
  expect(host.style.height).toBe('50px')
  // Transparent, so the silhouette below stays the visible fill.
  expect(['', 'transparent', 'rgba(0, 0, 0, 0)']).toContain(host.style.background)
})

it('commit puts the committed text back into the scene', async () => {
  const { container } = render(<Host start={DIAMOND} />)
  const root = rootOf(container)
  await userEvent.dblClick(root, { position: { x: 200, y: 150 } })
  await vi.waitFor(() => expect(nodeEditorContent(container)).not.toBeNull())
  await userEvent.keyboard('{Control>}{Enter}{/Control}')
  await vi.waitFor(() => expect(nodeEditorContent(container)).toBeNull())
  await vi.waitFor(() => expect(svgText(container)).toContain('shapefit'))
})

it('a plain rect node shows no doubled committed text under the now-transparent editor', async () => {
  const rect: SpatialCanvas = {
    nodes: [{ id: 'r1', type: 'text', x: 100, y: 100, width: 200, height: 100, text: 'rectbody' }],
    edges: [],
  }
  const { container } = render(<Host start={rect} />)
  await userEvent.dblClick(rootOf(container), { position: { x: 200, y: 150 } })
  await vi.waitFor(() => expect(nodeEditorContent(container)).not.toBeNull())
  await vi.waitFor(() => expect(svgText(container)).not.toContain('rectbody'))
})
