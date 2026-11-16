import {
  type CanvasLayoutCore,
  type CoreMismatch,
  type LayoutCore,
  layoutSpatialCanvasWithAnchors,
  type MeasureText,
  type SpatialContentCache,
} from '@kamiazya/whiteboard-canvas-render'
import { ensureViewerFontLoaded } from '@kamiazya/whiteboard-canvas-viewer/font-loading'
import { createBrowserMeasureText } from '@kamiazya/whiteboard-canvas-viewer/measure-text'
import { describe, expect, it } from 'vitest'
import { commands } from 'vitest/browser'
import { type WebLayoutBoard, webLayoutBoards } from '../../test-utils/web-layout-boards.js'
import { createSpatialContentCache } from '../content-cache.js'
import { editorLayoutBase } from './scene-render-core.js'
import type { WebCore } from './web-core.js'

/**
 * A drag frame laid out by the Rust core stays inside one display frame
 * (ADR-0054 step 7, S16b; owner question q79). The core's frame over its
 * resident content cache was measured at 4.7-5.3 ms on the 30-note working
 * board in Chromium, against the TypeScript's warm 3.0-3.5 ms (S15n): slower,
 * so the web's default moving to the core is held to a budget rather than to
 * parity. The budget is a frame at 60 Hz, 16.7 ms, on the median of the
 * frames timed — about three times the measurement, the headroom a slower
 * CI machine needs — over the largest board the web-layout set holds, laid
 * out as the editor composes it: the editor's base, its content cache, its
 * fragment table, its comments and proposals.
 *
 * Where the pipeline set VITE_WHITEBOARD_CORE a missing artifact FAILS this
 * file; elsewhere it skips and says so (as layout-core.browser.test.ts does).
 */

const FRAME_BUDGET_MS = 1000 / 60
const ROUNDS = 15

declare module 'vitest/browser' {
  interface BrowserCommands {
    printReading: (line: string) => Promise<void>
  }
}

const REQUIRED = (import.meta.env.VITE_WHITEBOARD_CORE ?? '') !== ''

async function loadRealCore(): Promise<{ core: WebCore } | { failure: unknown }> {
  try {
    // lazy-import: the artifact may be absent, and a static import of the module that names it would fail the whole file to load instead of skipping
    const { loadWebCore } = await import('./layout-core-source.js')
    return { core: await loadWebCore(fetch) }
  } catch (err) {
    return { failure: err }
  }
}
const real = await loadRealCore()

/** `real` switched to `rust` for the whole layout, counting the layouts it answered. */
function countedCore(core: WebCore) {
  const tally = { answered: 0, reports: [] as CoreMismatch[] }
  const layout: CanvasLayoutCore = {
    layoutSpatialCanvas(request, highlight, measure, cache) {
      const answer = core.layoutSpatialCanvas(request, highlight, measure, cache)
      if (!('declined' in answer)) tally.answered += 1
      return answer
    },
  }
  const switched: LayoutCore = {
    routing: core,
    layout,
    impl: { routeLayout: 'rust', layoutSpatialCanvas: 'rust' },
    onMismatch: (report) => tally.reports.push(report),
  }
  return { switched, tally }
}

/** `board` with its first node moved `dx` to the right: one drag frame. */
const frameOf = (board: WebLayoutBoard, dx: number) => ({
  ...board.canvas,
  nodes: board.canvas.nodes.map((node, at) => (at === 0 ? { ...node, x: node.x + dx } : node)),
})

const median = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN

/** Median ms of `ROUNDS` frames of `board`, each laid out as the editor composes one. */
function timedFrames(board: WebLayoutBoard, measure: MeasureText, core?: LayoutCore): number {
  const cache: SpatialContentCache = createSpatialContentCache()
  const lay = (at: number) =>
    layoutSpatialCanvasWithAnchors(frameOf(board, (at % 40) * 4), {
      ...editorLayoutBase({ measure }),
      core,
      contentCache: cache,
      // The editor's fragments ride as a table, which the core answers from.
      fragments: [],
      onFragmentsAsked: () => {},
      threads: board.threads,
      proposals: board.proposals,
    })
  for (let at = 0; at < 3; at += 1) lay(at)
  const times: number[] = []
  for (let at = 3; at < 3 + ROUNDS; at += 1) {
    const start = performance.now()
    lay(at)
    times.push(performance.now() - start)
  }
  return median(times)
}

/** The board the drag frame costs most on: the one with the most nodes. */
const largest = (): WebLayoutBoard =>
  [...webLayoutBoards()].sort(
    (a, b) => b.canvas.nodes.length - a.canvas.nodes.length,
  )[0] as WebLayoutBoard

describe('a drag frame laid out by the core', () => {
  it.runIf(REQUIRED)('finds the staged artifact where the pipeline promised it', () => {
    if ('failure' in real) throw real.failure
  })

  it.skipIf('failure' in real)(
    'stays inside one display frame on the largest editor board',
    {
      timeout: 60_000,
    },
    async () => {
      if ('failure' in real) return
      await ensureViewerFontLoaded()
      const board = largest()
      const browser = createBrowserMeasureText()
      const { switched, tally } = countedCore(real.core)
      const coreMs = timedFrames(board, browser, switched)
      const tsMs = timedFrames(board, browser)
      // Every timed frame was the core's: a declined one is the TypeScript's time.
      expect(tally.reports).toEqual([])
      expect(tally.answered).toBe(3 + ROUNDS)
      await commands.printReading(
        JSON.stringify({
          board: board.name,
          nodes: board.canvas.nodes.length,
          'core frame p50 ms': coreMs.toFixed(2),
          'ts frame p50 ms': tsMs.toFixed(2),
          'budget ms': FRAME_BUDGET_MS.toFixed(1),
        }),
      )
      expect(coreMs).toBeLessThan(FRAME_BUDGET_MS)
    },
  )
})
