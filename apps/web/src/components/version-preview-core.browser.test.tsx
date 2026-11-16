/**
 * Version history reaches the Rust core (ADR-0054 step 7, S18e): a past board
 * `VersionPreview` draws through canvas-render's `CanvasViewer` — its
 * measurer, its app theme, its math and diagram fragments — is a request the
 * gate hands the core, never one it skips.
 *
 * The switch reports a layout the core did not answer at debug, by class;
 * this counts them over each web-layout board and a board that typesets
 * math, in both themes, and requires none, with the core asked for every
 * board. Under the CI browser job's `differential` + `throw` a difference
 * fails the layout. Where no core is loaded (a run under `ts`) it skips, and
 * a run that set `VITE_WHITEBOARD_CORE` fails instead when the core did not
 * load.
 */

import type { CanvasLayoutCore, CoreImpl, LayoutCore } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { layoutCoreReady } from '../lib/spatial/layout-core.js'
import { type WebLayoutBoard, webLayoutBoards } from '../test-utils/web-layout-boards.js'
import { VersionPreview } from './VersionPreview.js'

afterEach(cleanup)

const REQUIRED = (import.meta.env.VITE_WHITEBOARD_CORE ?? '') !== ''
const loaded: LayoutCore | undefined = await layoutCoreReady()
const LAYOUT = loaded?.impl.layoutSpatialCanvas ?? 'ts'

it.runIf(REQUIRED)('loads the core the pipeline asked for before a version is laid out', () => {
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
  const spy = vi.spyOn(core.layout as CanvasLayoutCore, 'layoutSpatialCanvas')
  return { count: () => spy.mock.calls.length, restore: () => spy.mockRestore() }
}

const mount = (canvas: SpatialCanvas, theme: 'light' | 'dark') =>
  render(
    <div style={{ width: 800, height: 600 }}>
      <VersionPreview past={{ kind: 'spatial', canvas }} theme={theme} />
    </div>,
  )

const drawn = (container: HTMLElement) =>
  container.querySelector('[data-testid="canvas-viewer"]')?.innerHTML ?? ''

it.skipIf(LAYOUT === 'ts')(
  'hands the core every past board version history draws',
  async () => {
    const core = loaded as LayoutCore
    let checked = 0
    for (const theme of ['light', 'dark'] as const) {
      for (const board of [...webLayoutBoards(), MATH]) {
        const reports = unanswered()
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
          expect(
            { classes: reports.classes, asked: calls.count() > 0 },
            `${theme} ${board.name}`,
          ).toEqual({ classes: [], asked: true })
          checked += 1
        } finally {
          calls.restore()
          reports.restore()
          cleanup()
        }
      }
    }
    expect(checked).toBe(2 * (webLayoutBoards().length + 1))
  },
  60_000,
)

it.skipIf(LAYOUT === 'ts')(
  'draws a version byte for byte as the TypeScript does',
  async () => {
    const core = loaded as LayoutCore
    const impl = core.impl as { layoutSpatialCanvas?: CoreImpl }
    const before = impl.layoutSpatialCanvas
    const draw = async (as: CoreImpl, canvas: SpatialCanvas, theme: 'light' | 'dark') => {
      impl.layoutSpatialCanvas = as
      try {
        const { container } = mount(canvas, theme)
        await expect.poll(() => container.querySelector('svg g') !== null).toBe(true)
        return drawn(container)
      } finally {
        impl.layoutSpatialCanvas = before
        cleanup()
      }
    }
    for (const theme of ['light', 'dark'] as const) {
      for (const board of webLayoutBoards()) {
        const ts = await draw('ts', board.canvas, theme)
        expect(ts).not.toBe('')
        expect(await draw('rust', board.canvas, theme), `${theme} ${board.name}`).toBe(ts)
      }
    }
  },
  60_000,
)
