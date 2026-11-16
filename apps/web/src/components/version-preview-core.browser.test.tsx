/**
 * Version history reaches the Rust core (ADR-0054 step 7, S18e): a past board
 * `VersionPreview` draws through canvas-render's `CanvasViewer` — its
 * measurer, its app theme, its math and diagram fragments — is a request the
 * core is handed (an option no request carries would throw and fail it).
 *
 * This mounts each web-layout board and a board that typesets math, in both
 * themes, with the core asked for every board; and holds the core's picture
 * of each board, measured by this browser, to the TypeScript composer's.
 */

import {
  type CanvasLayoutCore,
  createSpatialTheme,
  type LayoutCore,
  layoutSpatialCanvas,
} from '@kamiazya/whiteboard-canvas-render'
import { createBrowserMeasureText } from '@kamiazya/whiteboard-canvas-viewer'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { layoutCoreReady } from '../lib/spatial/layout-core.js'
import { requireLayoutCore } from '../lib/spatial/require-layout-core.js'
import { type WebLayoutBoard, webLayoutBoards } from '../test-utils/web-layout-boards.js'
import { VersionPreview } from './VersionPreview.js'

afterEach(cleanup)

const loaded: LayoutCore | undefined = await layoutCoreReady()

it('loads the core before a version is laid out', () => {
  expect(loaded).toBeDefined()
})

const MATH: WebLayoutBoard = {
  name: 'display and inline math',
  canvas: {
    nodes: [
      textNode({ id: 'm', x: 0, y: 0, width: 260, height: 160, text: '$$\nx^2\n$$\n' }),
      textNode({ id: 'i', x: 320, y: 0, width: 260, height: 120, text: 'inline $a+b$ here' }),
    ],
    edges: [],
  } as SpatialCanvas,
}

/** Counts the layouts the loaded core is asked for. */
function asked(core: LayoutCore): { count: () => number; restore: () => void } {
  const spy = vi.spyOn(core.layout as CanvasLayoutCore, 'layoutSpatialCanvas')
  return { count: () => spy.mock.calls.length, restore: () => spy.mockRestore() }
}

const mount = (canvas: SpatialCanvas, theme: 'light' | 'dark') =>
  render(
    <div style={{ width: 800, height: 600 }}>
      <VersionPreview past={{ kind: 'spatial', canvas }} theme={theme} />
    </div>,
  )

it('hands the core every past board version history draws', async () => {
  const core = loaded as LayoutCore
  let checked = 0
  for (const theme of ['light', 'dark'] as const) {
    for (const board of [...webLayoutBoards(), MATH]) {
      const calls = asked(core)
      try {
        const { container } = mount(board.canvas, theme)
        await expect.poll(() => container.querySelector('svg g') !== null).toBe(true)
        if (board === MATH) {
          // The fragment lands, and the layout that draws it is the core's too.
          await expect
            .poll(() => container.querySelector('[data-mml-node="math"]') !== null, {
              timeout: 20_000,
            })
            .toBe(true)
        }
        expect(calls.count(), `${theme} ${board.name}`).toBeGreaterThan(0)
        checked += 1
      } finally {
        calls.restore()
        cleanup()
      }
    }
  }
  expect(checked).toBe(2 * (webLayoutBoards().length + 1))
}, 60_000)

it("lays every past board out as the TypeScript composer does, in this browser's measure", () => {
  const core = loaded as LayoutCore
  const measure = createBrowserMeasureText()
  for (const mode of ['light', 'dark'] as const) {
    for (const board of webLayoutBoards()) {
      const options = {
        measure,
        appearance: createSpatialTheme({ mode }),
        style: 'document' as const,
      }
      const ts = layoutSpatialCanvas(board.canvas, { ...options, core: requireLayoutCore() })
      expect(ts.nodes.length, board.name).toBeGreaterThan(0)
      expect(
        layoutSpatialCanvas(board.canvas, { ...options, core }),
        `${mode} ${board.name}`,
      ).toEqual(ts)
    }
  }
})
