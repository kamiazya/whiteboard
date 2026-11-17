import {
  type CanvasLayoutCore,
  describeMeasure,
  type EdgeAnchorOverride,
  type LayoutCore,
  layoutSpatialCanvasWithAnchors,
  layoutSpatialEdges,
  type MeasureText,
  measureSpecOf,
  type QueryLayoutCore,
  type SpatialContentCache,
  type TextMetrics,
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
 * so the web's default moving to the core was held to a budget rather than to
 * parity, and with the TypeScript layout deleted (S18h) the budget is all
 * there is to hold it to. The budget is a frame at 60 Hz, 16.7 ms — about
 * three times the measurement, the headroom a slower CI machine needs — over
 * the largest board the web-layout set holds, laid out as the editor composes
 * it: the editor's base, its content cache, its fragment table, its comments
 * and proposals.
 *
 * What is held to the budget is the BEST of `BATCHES` independent batch
 * medians, not one median. A wall-clock reading taken while other work runs
 * can only be inflated by it, never deflated, so the best batch estimates the
 * unloaded cost, while a frame that really costs more than the budget is over
 * it in every batch. One median failed on CI's stress job (21.4 ms) with a
 * dozen browser files running in the same process, where the same commit read
 * 5.4-7.7 ms everywhere else — a budget judged on a measurement taken under
 * load (steward's flake-shapes, `property-timeout-reads-as-failure`, "a
 * budget sized on a measurement"; and `lcp-floor-median-noise`, where a
 * MINIMUM over the floor is the real regression). The budget did not move.
 *
 * Every browser run needs the artifact: a missing one FAILS this file's first
 * test, and the timed cases skip, saying so (as layout-core.browser.test.ts does).
 */

const FRAME_BUDGET_MS = 1000 / 60
/** Frames in one batch, whose median is one reading. */
const ROUNDS = 15
/** Independent batches; the best one's median is what the budget judges. */
const BATCHES = 5
/** Frames laid out before any is timed. */
const WARM = 3

declare module 'vitest/browser' {
  interface BrowserCommands {
    printReading: (line: string) => Promise<void>
  }
}

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
/** No artifact to time: each timed case skips and says so. */
const ABSENT = 'failure' in real

/** `real` for the whole layout, counting the layouts it answered. */
function countedCore(core: WebCore) {
  const tally = { answered: 0 }
  const layout: CanvasLayoutCore = {
    layoutSpatialCanvas(request, highlight, measure, cache) {
      const answer = core.layoutSpatialCanvas(request, highlight, measure, cache)
      if (!('refused' in answer)) tally.answered += 1
      return answer
    },
  }
  const switched: LayoutCore = { routing: core, layout, markdown: core, query: core }
  return { switched, tally }
}

/** `real` for the queries, counting the edge layers it answered. */
function countedQueries(core: WebCore) {
  const tally = { answered: 0 }
  const query: QueryLayoutCore = {
    layoutQuery(request, highlight, measure) {
      const answer = core.layoutQuery(request, highlight, measure)
      if (!('refused' in answer)) tally.answered += 1
      return answer
    },
  }
  const switched: LayoutCore = { routing: core, layout: core, markdown: core, query }
  return { switched, tally }
}

/**
 * The measurer the overlay lays a gesture's frames out with: the page's,
 * memoised per gesture and named as the page's (`use-drag-layers.ts`).
 */
function gestureMeasure(page: MeasureText): MeasureText {
  const memo = new Map<string, TextMetrics>()
  const measure: MeasureText = (text, font) => {
    const key = `${font.family}|${font.weight}|${font.style}|${font.sizePx}\u0000${text}`
    const hit = memo.get(key) ?? page(text, font)
    memo.set(key, hit)
    return hit
  }
  return describeMeasure(measure, measureSpecOf(page))
}

/** The node whose edges the overlay re-routes most: the one the most edges touch. */
function busiest(board: WebLayoutBoard): string {
  const touches = new Map<string, number>()
  for (const edge of board.canvas.edges) {
    for (const end of [edge.from.node, edge.to.node]) touches.set(end, (touches.get(end) ?? 0) + 1)
  }
  return [...touches].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
}

/**
 * The batch medians of overlay frames of `board` with its busiest node carried
 * `dx` further each frame, as `use-drag-layers.ts` lays one out: the edge layer
 * alone, every bystander pinned at its committed anchors and, `cached`, the
 * carried edges at their committed sides too, which skips the side search.
 */
function timedOverlay(
  board: WebLayoutBoard,
  page: MeasureText,
  cached: boolean,
  core: LayoutCore,
): number[] {
  const measure = gestureMeasure(page)
  const base = editorLayoutBase({ measure })
  const { scene, anchors } = layoutSpatialCanvasWithAnchors(board.canvas, { ...base, core })
  const moved = busiest(board)
  const carried = new Set(
    board.canvas.edges.filter((e) => e.from.node === moved || e.to.node === moved).map((e) => e.id),
  )
  const overrides = new Map<string, EdgeAnchorOverride>()
  for (const node of scene.nodes) {
    if (node.kind !== 'edge') continue
    const sides = { fromSide: node.fromSide, toSide: node.toSide }
    if (carried.has(node.id)) {
      if (cached) overrides.set(node.id, sides)
      continue
    }
    overrides.set(node.id, { ...sides, ...anchors.get(node.id) })
  }
  const lay = (at: number) =>
    layoutSpatialEdges(
      {
        ...board.canvas,
        nodes: board.canvas.nodes.map((n) =>
          n.id === moved ? { ...n, x: n.x + (at % 40) * 4 } : n,
        ),
      },
      { ...base, core, edgeSideOverrides: overrides },
    )
  return batchMedians(lay)
}

/** `board` with its first node moved `dx` to the right: one drag frame. */
const frameOf = (board: WebLayoutBoard, dx: number) => ({
  ...board.canvas,
  nodes: board.canvas.nodes.map((node, at) => (at === 0 ? { ...node, x: node.x + dx } : node)),
})

const median = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN

/**
 * The median ms of each of `BATCHES` batches of `ROUNDS` frames, after `WARM`
 * untimed ones: `lay(at)` lays frame `at` out. The budget is judged on the
 * best (`Math.min`); the rest are printed so a loaded run reads as one.
 */
function batchMedians(lay: (at: number) => unknown): number[] {
  for (let at = 0; at < WARM; at += 1) lay(at)
  const medians: number[] = []
  let at = WARM
  for (let batch = 0; batch < BATCHES; batch += 1) {
    const times: number[] = []
    for (let round = 0; round < ROUNDS; round += 1, at += 1) {
      const start = performance.now()
      lay(at)
      times.push(performance.now() - start)
    }
    medians.push(median(times))
  }
  return medians
}

const FRAMES_LAID = WARM + BATCHES * ROUNDS
const readings = (medians: readonly number[]) => medians.map((ms) => ms.toFixed(2)).join(' ')

/** The batch medians of `board`'s frames, each laid out as the editor composes one. */
function timedFrames(board: WebLayoutBoard, measure: MeasureText, core: LayoutCore): number[] {
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
  return batchMedians(lay)
}

/** The board the overlay costs most on: the one with the most edges. */
const mostEdges = (): WebLayoutBoard =>
  [...webLayoutBoards()].sort(
    (a, b) => b.canvas.edges.length - a.canvas.edges.length,
  )[0] as WebLayoutBoard

/** The board the drag frame costs most on: the one with the most nodes. */
const largest = (): WebLayoutBoard =>
  [...webLayoutBoards()].sort(
    (a, b) => b.canvas.nodes.length - a.canvas.nodes.length,
  )[0] as WebLayoutBoard

describe('a drag frame laid out by the core', () => {
  it('finds the staged artifact where the pipeline promised it', () => {
    if ('failure' in real) throw real.failure
  })

  it.skipIf(ABSENT)(
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
      const medians = timedFrames(board, browser, switched)
      // Every frame was one the core laid out: a refused one is drawn as the refusal.
      expect(tally.answered).toBe(FRAMES_LAID)
      await commands.printReading(
        JSON.stringify({
          board: board.name,
          nodes: board.canvas.nodes.length,
          'core frame p50 ms per batch': readings(medians),
          'budget ms': FRAME_BUDGET_MS.toFixed(1),
        }),
      )
      expect(Math.min(...medians)).toBeLessThan(FRAME_BUDGET_MS)
    },
  )

  it.skipIf(ABSENT)(
    'lays the drag overlay out through the core inside one display frame',
    { timeout: 60_000 },
    async () => {
      if ('failure' in real) return
      await ensureViewerFontLoaded()
      const board = mostEdges()
      const browser = createBrowserMeasureText()
      const { switched, tally } = countedQueries(real.core)
      const reading: Record<string, string | number> = {
        board: board.name,
        edges: board.canvas.edges.length,
        'budget ms': FRAME_BUDGET_MS.toFixed(1),
      }
      const best: number[] = []
      for (const cached of [false, true]) {
        const mode = cached ? 'cached sides' : 're-siding'
        const medians = timedOverlay(board, browser, cached, switched)
        reading[`core ${mode} p50 ms per batch`] = readings(medians)
        best.push(Math.min(...medians))
      }
      // Every frame was one the core answered: a refused edge layer is no edges.
      expect(tally.answered).toBe(2 * FRAMES_LAID)
      await commands.printReading(JSON.stringify(reading))
      for (const ms of best) expect(ms).toBeLessThan(FRAME_BUDGET_MS)
    },
  )
})
