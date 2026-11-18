import {
  type CanvasLayoutCore,
  describeMeasure,
  type EdgeAnchorOverride,
  type LayoutCore,
  layoutSpatialCanvasKeyedPicture,
  layoutSpatialCanvasWithAnchors,
  layoutSpatialEdges,
  layoutSpatialEdgesPicture,
  type MeasureText,
  measureSpecOf,
  type QueryLayoutCore,
  renderSceneToKeyedSvg,
  renderSceneToSvg,
  type SceneNode,
  type SpatialContentCache,
  type SpatialLayoutOptions,
  sceneBounds,
  type TextMetrics,
} from '@kamiazya/whiteboard-canvas-render'
import { ensureViewerFontLoaded } from '@kamiazya/whiteboard-canvas-viewer/font-loading'
import { createBrowserMeasureText } from '@kamiazya/whiteboard-canvas-viewer/measure-text'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
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
 *
 * The overlay frame's SPLIT — the edge layer alone, against the layer with its
 * SVG drawn by the core in the same call (what `use-drag-layers.ts` draws),
 * against the layer with the TypeScript backend's SVG — is a measurement, not a guard: it
 * asserts only that it measured something, and runs when
 * `VITE_MEASURE_DRAG_SVG=1` (a timing loop has no place in every CI run).
 * The committed layout's split — the layout alone, against the layout with the
 * editor surface's keyed projection drawn by the core in the same call, against
 * the layout with the TypeScript backend's keyed projection (what the main
 * thread derived from a worker's scene until ADR-0054 A3.3) — and what a
 * `structuredClone` of the keyed answer alone, and of the scene alone, costs
 * in this realm: two fields of a worker's reply, not the whole reply (which
 * also carries bounds and anchors) and not its delivery, run under the same
 * switch. Run from the repository root:
 *   VITE_MEASURE_DRAG_SVG=1 pnpm vitest run --project web-browser apps/web/src/lib/spatial/drag-frame-budget
 */
const SPLIT = import.meta.env.VITE_MEASURE_DRAG_SVG === '1'

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

/** One overlay frame's input: the canvas and options its edge layer is laid out from. */
type OverlayFrame = readonly [SpatialCanvas, SpatialLayoutOptions]

/**
 * Overlay frames of `board` with its busiest node carried 4 px further each
 * frame, as `use-drag-layers.ts` lays one out: `frame(at)` is frame `at`'s
 * input, every bystander pinned at its committed anchors and, `cached`, the
 * carried edges at their committed sides too, which skips the side search.
 */
function overlayInputs(
  board: WebLayoutBoard,
  page: MeasureText,
  cached: boolean,
  core: LayoutCore,
): (at: number) => OverlayFrame {
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
  const options: SpatialLayoutOptions = { ...base, core, edgeSideOverrides: overrides }
  return (at: number) => [
    {
      ...board.canvas,
      nodes: board.canvas.nodes.map((n) => (n.id === moved ? { ...n, x: n.x + (at % 40) * 4 } : n)),
    },
    options,
  ]
}

/** `overlayInputs`' frames, each laid out as its edge layer alone. */
function overlayFrames(
  board: WebLayoutBoard,
  page: MeasureText,
  cached: boolean,
  core: LayoutCore,
): (at: number) => SceneNode[] {
  const frame = overlayInputs(board, page, cached, core)
  return (at: number) => layoutSpatialEdges(...frame(at))
}

/** The batch medians of `board`'s overlay frames; see `overlayFrames`. */
function timedOverlay(
  board: WebLayoutBoard,
  page: MeasureText,
  cached: boolean,
  core: LayoutCore,
): number[] {
  return batchMedians(overlayFrames(board, page, cached, core))
}

/** The overlay's envelope as the core's ask: the layer's own bounds, at their size. */
const OVERLAY_ASK = { viewBox: { of: 'scene' } } as const

/** An edge layer drawn by the TypeScript backend in the overlay's envelope: its own bounds. */
function overlaySvg(nodes: SceneNode[]): string {
  const bounds = sceneBounds({ nodes })
  return renderSceneToSvg({ nodes }, { width: bounds.w, height: bounds.h, viewBox: bounds })
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

/**
 * `batchMedians` over several rows at once, interleaved round by round so a
 * slow stretch of the run charges every row alike: each row's batch medians.
 */
function interleavedMedians(
  rows: Readonly<Record<string, (at: number) => unknown>>,
): Record<string, number[]> {
  const names = Object.keys(rows)
  for (let at = 0; at < WARM; at += 1) for (const name of names) rows[name]?.(at)
  const medians: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []]))
  let at = WARM
  for (let batch = 0; batch < BATCHES; batch += 1) {
    const times: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []]))
    for (let round = 0; round < ROUNDS; round += 1, at += 1) {
      for (const name of names) {
        const start = performance.now()
        rows[name]?.(at)
        times[name]?.push(performance.now() - start)
      }
    }
    for (const name of names) medians[name]?.push(median(times[name] ?? []))
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

/** The editor surface's envelope, as the core is asked for it (`scene-render-core.ts`). */
const EDITOR_ASK = { viewBox: { of: 'scene' }, legend: 'omit' } as const

/** The same envelope as `renderSceneToKeyedSvg`'s options over `scene`. */
function editorKeyedTs(scene: Parameters<typeof sceneBounds>[0]) {
  const bounds = sceneBounds(scene)
  return renderSceneToKeyedSvg(scene, {
    width: bounds.w,
    height: bounds.h,
    viewBox: bounds,
    legend: 'omit',
  })
}

/** The options a committed layout is composed with, over its own content cache. */
function committedOptions(board: WebLayoutBoard, measure: MeasureText, core: LayoutCore) {
  return {
    ...editorLayoutBase({ measure }),
    core,
    contentCache: createSpatialContentCache(),
    fragments: [],
    onFragmentsAsked: () => {},
    threads: board.threads,
    proposals: board.proposals,
  } satisfies SpatialLayoutOptions
}

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

  it.runIf(SPLIT && !ABSENT)(
    'splits the overlay frame into its edge layer and either SVG',
    { timeout: 120_000 },
    async () => {
      if ('failure' in real) return
      await ensureViewerFontLoaded()
      const board = mostEdges()
      const browser = createBrowserMeasureText()
      const core: LayoutCore = {
        routing: real.core,
        layout: real.core,
        markdown: real.core,
        query: real.core,
      }
      const reading: Record<string, string | number> = {
        board: board.name,
        edges: board.canvas.edges.length,
      }
      for (const cached of [false, true]) {
        const mode = cached ? 'cached sides' : 're-siding'
        const frame = overlayInputs(board, browser, cached, core)
        const lay = (at: number) => layoutSpatialEdges(...frame(at))
        // The two pictures are the same bytes (core-picture-web.rust.test.ts);
        // asserted once here too, so the rows time the same work.
        const [canvas, options] = frame(0)
        expect(layoutSpatialEdgesPicture(canvas, options, OVERLAY_ASK).svg).toBe(
          overlaySvg(layoutSpatialEdges(canvas, options)),
        )
        const medians = interleavedMedians({
          layer: lay,
          'layer + core svg': (at) => layoutSpatialEdgesPicture(...frame(at), OVERLAY_ASK),
          'layer + TS svg': (at) => overlaySvg(lay(at)),
        })
        for (const [row, values] of Object.entries(medians)) {
          expect(values).toHaveLength(BATCHES)
          reading[`${mode}: ${row} p50 ms per batch`] = readings(values)
        }
      }
      await commands.printReading(JSON.stringify(reading))
    },
  )
  it.runIf(SPLIT && !ABSENT)(
    'splits the committed layout into its layout and either keyed picture',
    { timeout: 120_000 },
    async () => {
      if ('failure' in real) return
      await ensureViewerFontLoaded()
      const browser = createBrowserMeasureText()
      // Every lane laid out by the core: a refused layout is drawn as its
      // notice in TypeScript, which would time two identical refusals.
      const tally = { answered: 0, keyed: 0 }
      const layout: CanvasLayoutCore = {
        layoutSpatialCanvas(request, highlight, measure, cache) {
          const answer = real.core.layoutSpatialCanvas(request, highlight, measure, cache)
          if (!('refused' in answer)) tally.answered += 1
          if ('keyed' in answer && answer.keyed !== undefined) tally.keyed += 1
          return answer
        },
      }
      const core: LayoutCore = { routing: real.core, layout, markdown: real.core, query: real.core }
      const reading: Record<string, string | number> = {}
      for (const board of [mostEdges(), largest()]) {
        tally.answered = 0
        tally.keyed = 0
        const plain = committedOptions(board, browser, core)
        const withCore = committedOptions(board, browser, core)
        const withTs = committedOptions(board, browser, core)
        const at0 = frameOf(board, 0)
        // The same bytes either way (core-picture-web.rust.test.ts), asserted
        // once here too so the rows time the same work.
        const scene = layoutSpatialCanvasWithAnchors(at0, plain).scene
        const keyed = layoutSpatialCanvasKeyedPicture(at0, withCore, EDITOR_ASK).keyed
        expect(keyed.svg).toBe(editorKeyedTs(scene).svg)
        const medians = interleavedMedians({
          layout: (at) => layoutSpatialCanvasWithAnchors(frameOf(board, (at % 40) * 4), plain),
          'layout + core keyed': (at) =>
            layoutSpatialCanvasKeyedPicture(frameOf(board, (at % 40) * 4), withCore, EDITOR_ASK),
          'layout + TS keyed': (at) =>
            editorKeyedTs(
              layoutSpatialCanvasWithAnchors(frameOf(board, (at % 40) * 4), withTs).scene,
            ),
          'TS keyed alone': () => editorKeyedTs(scene),
          'local structuredClone of keyed': () => structuredClone(keyed),
          'local structuredClone of scene': () => structuredClone(scene),
        })
        // Three lanes lay out every frame, plus the two equality layouts above;
        // the keyed lane and its equality layout answered keyed.
        expect(tally.answered).toBe(3 * FRAMES_LAID + 2)
        expect(tally.keyed).toBe(FRAMES_LAID + 1)
        reading[`${board.name}: nodes`] = board.canvas.nodes.length
        reading[`${board.name}: keyed chars`] = keyed.svg.length
        for (const [row, values] of Object.entries(medians)) {
          expect(values).toHaveLength(BATCHES)
          reading[`${board.name}: ${row} p50 ms per batch`] = readings(values)
        }
      }
      await commands.printReading(JSON.stringify(reading))
    },
  )
})
