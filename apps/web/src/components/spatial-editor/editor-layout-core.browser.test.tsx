/**
 * The editor's own layouts reach the Rust core (ADR-0054 step 7, S16b): the
 * committed scene the editor composes — its measurer, its document style,
 * its reference bundle, its math and diagram fragments, its comments and
 * proposals — is a request the core is handed.
 *
 * An option no request carries would throw (`CoreUnaskable`) and fail the
 * render; this mounts the editor's real composition of each web-layout board
 * and a board that typesets math, with the core asked at least once per board.
 */

import type { CanvasLayoutCore, LayoutCore } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { layoutCoreReady } from '../../lib/spatial/layout-core.js'
import { type WebLayoutBoard, webLayoutBoards } from '../../test-utils/web-layout-boards.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const loaded: LayoutCore | undefined = await layoutCoreReady()

it('loads the core before the editor lays out', () => {
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
  const layout = core.layout as CanvasLayoutCore
  const spy = vi.spyOn(layout, 'layoutSpatialCanvas')
  return { count: () => spy.mock.calls.length, restore: () => spy.mockRestore() }
}

it("hands the core every layout of the editor's own composition", async () => {
  const core = loaded as LayoutCore
  let checked = 0
  for (const board of [...webLayoutBoards(), MATH]) {
    const calls = asked(core)
    try {
      const { container } = render(
        <div style={{ width: 1000, height: 700 }}>
          <SpatialEditor
            canvas={board.canvas}
            threads={board.threads}
            proposals={board.proposals}
            onChange={() => {}}
            theme="light"
          />
        </div>,
      )
      await expect.poll(() => container.querySelector('svg g') !== null).toBe(true)
      if (board === MATH) {
        // The fragment lands, and the layout that draws it is the core's too.
        await expect
          .poll(() => container.querySelector('[data-mml-node="math"]') !== null, {
            timeout: 20_000,
          })
          .toBe(true)
      }
      expect(calls.count(), board.name).toBeGreaterThan(0)
      checked += 1
    } finally {
      calls.restore()
      cleanup()
    }
  }
  expect(checked).toBe(webLayoutBoards().length + 1)
}, 60_000)
