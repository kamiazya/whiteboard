/**
 * The editor's own layouts reach the Rust core (ADR-0054 step 7, S16b): the
 * committed scene the editor composes — its measurer, its document style,
 * its reference bundle, its math and diagram fragments, its comments and
 * proposals — is a request the gate hands the core, never one it skips.
 *
 * The switch reports a layout the core did not answer at debug, by class
 * (`skipped:<reason>`, `declined:<class>`); this counts them over the
 * editor's real composition of each web-layout board and a board that
 * typesets math, and requires none, with the core asked at least once per
 * board. Under the CI browser job's `differential` + `throw` a difference
 * fails the layout; where no core is loaded (a run under `ts`, which loads
 * none) the census skips, and a run that set `VITE_WHITEBOARD_CORE` fails
 * instead of skipping when the core did not load.
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

const REQUIRED = (import.meta.env.VITE_WHITEBOARD_CORE ?? '') !== ''
const loaded: LayoutCore | undefined = await layoutCoreReady()
const LAYOUT = loaded?.impl.layoutSpatialCanvas ?? 'ts'

it.runIf(REQUIRED)('loads the core the pipeline asked for before the editor lays out', () => {
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

/** What the switch reports at debug from now until restored: one `kind:reason` per layout the core did not answer. */
function unanswered(): { readonly classes: string[]; readonly restore: () => void } {
  const classes: string[] = []
  const spy = vi.spyOn(console, 'debug').mockImplementation((...args: unknown[]) => {
    const [message, report] = args as [string, { kind?: string; reason?: string } | undefined]
    if (typeof message === 'string' && message.includes('did not answer this layout')) {
      classes.push(`${report?.kind}:${report?.reason}`)
    }
  })
  return { classes, restore: () => spy.mockRestore() }
}

/** Counts the layouts the loaded core is asked for. */
function asked(core: LayoutCore): { count: () => number; restore: () => void } {
  const layout = core.layout as CanvasLayoutCore
  const spy = vi.spyOn(layout, 'layoutSpatialCanvas')
  return { count: () => spy.mock.calls.length, restore: () => spy.mockRestore() }
}

it.skipIf(LAYOUT === 'ts')(
  "hands the core every layout of the editor's own composition",
  async () => {
    const core = loaded as LayoutCore
    let checked = 0
    for (const board of [...webLayoutBoards(), MATH]) {
      const reports = unanswered()
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
        expect({ classes: reports.classes, asked: calls.count() > 0 }, board.name).toEqual({
          classes: [],
          asked: true,
        })
        checked += 1
      } finally {
        calls.restore()
        reports.restore()
        cleanup()
      }
    }
    expect(checked).toBe(webLayoutBoards().length + 1)
  },
  60_000,
)
