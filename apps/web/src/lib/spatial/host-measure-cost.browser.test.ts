import {
  type CanvasLayoutCore,
  type CoreMismatch,
  describeMeasure,
  type FontDescriptor,
  type LayoutCore,
  layoutSpatialCanvasWithAnchors,
  type MeasureText,
  type TextMetrics,
} from '@kamiazya/whiteboard-canvas-render'
import { ensureViewerFontLoaded } from '@kamiazya/whiteboard-canvas-viewer/font-loading'
import { createBrowserMeasureText } from '@kamiazya/whiteboard-canvas-viewer/measure-text'
import { describe, expect, it } from 'vitest'
import { type WebLayoutBoard, webLayoutBoards } from '../../test-utils/web-layout-boards.js'
import { editorLayoutBase } from './scene-render-core.js'
import type { WebCore } from './web-core.js'

/**
 * What the Rust core's whole layout would pay to measure through the browser
 * (ADR-0054 step 7, owner decision q77): a synchronous host import, called
 * from inside the wasm once per distinct (text, font) a layout asks for.
 *
 * Per board it counts the measure calls the TypeScript layout makes and the
 * distinct pairs among them, times that layout and the time it spends in the
 * measurer, and prices one crossing: a wasm module whose import does what the
 * wasm-bindgen glue does for `(text: &str, font: &str) -> [f64; 4]` — decode
 * both strings from linear memory, find the descriptor by its key, measure,
 * write four doubles back — timed with the measurer stubbed (the crossing
 * alone) and with the real one.
 *
 * The second measurement is the import itself, once built: each board laid
 * out by the real core under `rust`, the browser's measurer asked through
 * the import, against the TypeScript's layout, interleaved round by round.
 *
 * A measurement, not a guard: it asserts only that it measured something,
 * and runs when `VITE_MEASURE_HOST_COST=1` (a timing loop has no place in
 * every CI run). Run from apps/web:
 *   VITE_MEASURE_HOST_COST=1 pnpm vitest run --project web-browser host-measure-cost
 */
const RUN = import.meta.env.VITE_MEASURE_HOST_COST === '1'

// (module
//   (import "env" "m" (func (param i32 i32 i32 i32 i32)))
//   (import "env" "mem" (memory 1))
//   (func (export "call") (param i32 i32 i32 i32 i32)
//     local.get 0 local.get 1 local.get 2 local.get 3 local.get 4 call 0))
// prettier-ignore
const CROSSING_MODULE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x09, 0x01, 0x60, 0x05, 0x7f, 0x7f, 0x7f,
  0x7f, 0x7f, 0x00, 0x02, 0x14, 0x02, 0x03, 0x65, 0x6e, 0x76, 0x01, 0x6d, 0x00, 0x00, 0x03, 0x65,
  0x6e, 0x76, 0x03, 0x6d, 0x65, 0x6d, 0x02, 0x00, 0x01, 0x03, 0x02, 0x01, 0x00, 0x07, 0x08, 0x01,
  0x04, 0x63, 0x61, 0x6c, 0x6c, 0x00, 0x01, 0x0a, 0x10, 0x01, 0x0e, 0x00, 0x20, 0x00, 0x20, 0x01,
  0x20, 0x02, 0x20, 0x03, 0x20, 0x04, 0x10, 0x00, 0x0b,
])

const keyOf = (font: FontDescriptor): string =>
  JSON.stringify([font.family, font.fallbackChain, font.weight, font.style, font.sizePx])

interface Call {
  readonly text: string
  readonly font: FontDescriptor
}

/** `measure`, recording every call and the time spent inside it. */
function recording(measure: MeasureText) {
  const calls: Call[] = []
  let ms = 0
  const counted: MeasureText = (text, font) => {
    const start = performance.now()
    const metrics = measure(text, font)
    ms += performance.now() - start
    calls.push({ text, font })
    return metrics
  }
  return {
    counted,
    calls,
    spent: () => ms,
    reset: () => {
      calls.length = 0
      ms = 0
    },
  }
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN
}

function layOut(board: WebLayoutBoard, measure: MeasureText, core?: LayoutCore): void {
  layoutSpatialCanvasWithAnchors(board.canvas, {
    ...editorLayoutBase({ measure }),
    core,
    threads: board.threads,
    proposals: board.proposals,
  })
}

/** Per-call microseconds of `calls` through the crossing module, each measured by `measure`. */
async function crossingMicros(calls: readonly Call[], measure: MeasureText): Promise<number> {
  const memory = new WebAssembly.Memory({ initial: 64 })
  const encoder = new TextEncoder()
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true })
  const fonts = new Map<string, FontDescriptor>()
  const import_ = (tp: number, tl: number, fp: number, fl: number, out: number): void => {
    const bytes = new Uint8Array(memory.buffer)
    const text = decoder.decode(bytes.subarray(tp, tp + tl))
    const key = decoder.decode(bytes.subarray(fp, fp + fl))
    let font = fonts.get(key)
    if (font === undefined) {
      const [family, fallbackChain, weight, style, sizePx] = JSON.parse(key)
      font = { family, fallbackChain, weight, style, sizePx }
      fonts.set(key, font)
    }
    const m: TextMetrics = measure(text, font)
    const view = new Float64Array(memory.buffer, out, 4)
    view[0] = m.advanceWidth
    view[1] = m.ascent
    view[2] = m.descent
    view[3] = m.lineGap
  }
  const { instance } = await WebAssembly.instantiate(CROSSING_MODULE, {
    env: { m: import_, mem: memory },
  })
  const call = instance.exports.call as (...args: number[]) => void
  // Every call's strings laid out once, so the loop times the crossing alone.
  const bytes = new Uint8Array(memory.buffer)
  let at = 64
  const laid = calls.map(({ text, font }) => {
    const t = encoder.encode(text)
    const f = encoder.encode(keyOf(font))
    bytes.set(t, at)
    bytes.set(f, at + t.length)
    const row = [at, t.length, at + t.length, f.length]
    at += t.length + f.length
    return row as [number, number, number, number]
  })
  const out = (at + 7) & ~7
  const rounds = Math.max(1, Math.ceil(20_000 / laid.length))
  for (const [tp, tl, fp, fl] of laid) call(tp, tl, fp, fl, out)
  const start = performance.now()
  for (let r = 0; r < rounds; r += 1) for (const [tp, tl, fp, fl] of laid) call(tp, tl, fp, fl, out)
  return ((performance.now() - start) * 1000) / (rounds * laid.length)
}

const STUB: MeasureText = () => ({ advanceWidth: 1, ascent: 1, descent: 1, lineGap: 0 })

describe.runIf(RUN)('the browser measurer as a host import: what it would cost', () => {
  it('prices the crossing against each board’s TypeScript layout', {
    timeout: 120_000,
  }, async () => {
    await ensureViewerFontLoaded()
    const browser = createBrowserMeasureText()
    const rows: Record<string, number | string>[] = []
    for (const board of webLayoutBoards()) {
      const rec = recording(browser)
      for (let i = 0; i < 3; i += 1) layOut(board, rec.counted)
      const totals: number[] = []
      const inMeasure: number[] = []
      for (let i = 0; i < 9; i += 1) {
        rec.reset()
        const start = performance.now()
        layOut(board, rec.counted)
        totals.push(performance.now() - start)
        inMeasure.push(rec.spent())
      }
      const calls = [...rec.calls]
      const distinct = [
        ...new Map(calls.map((c) => [`${keyOf(c.font)}\u0000${c.text}`, c])).values(),
      ]
      const crossUs = await crossingMicros(distinct, STUB)
      const measuredUs = await crossingMicros(distinct, browser)
      const tsMs = median(totals)
      const measureMs = median(inMeasure)
      // What the core would spend measuring: each distinct pair once, through the crossing.
      const hostMs = (distinct.length * measuredUs) / 1000
      rows.push({
        board: board.name,
        calls: calls.length,
        distinct: distinct.length,
        'ts layout ms': tsMs.toFixed(2),
        'ts in measure ms': measureMs.toFixed(2),
        'crossing µs': crossUs.toFixed(3),
        'crossing+measure µs': measuredUs.toFixed(3),
        'core host ms (projected)': hostMs.toFixed(3),
        'crossing share of ts layout': `${(((distinct.length * crossUs) / 1000 / tsMs) * 100).toFixed(2)}%`,
      })
      expect(calls.length).toBeGreaterThan(0)
    }
    console.table(rows)
    console.info(JSON.stringify(rows))
  })
})

/**
 * `real` switched to `rust` for the whole layout, counting the layouts the
 * core itself answered and keeping every report the switch made: a layout it
 * skipped, declined or refused is drawn by the TypeScript with the same
 * measurer, so its time would otherwise read as the core's.
 */
function countedCore(real: WebCore) {
  const tally = { answered: 0, reports: [] as CoreMismatch[] }
  const layout: CanvasLayoutCore = {
    layoutSpatialCanvas(request, highlight, measure) {
      const answer = real.layoutSpatialCanvas(request, highlight, measure)
      if (!('declined' in answer)) tally.answered += 1
      return answer
    },
  }
  const core: LayoutCore = {
    routing: real,
    layout,
    impl: { routeLayout: 'rust', layoutSpatialCanvas: 'rust' },
    onMismatch: (report) => tally.reports.push(report),
  }
  return { core, tally }
}

/**
 * Medians of `rounds` interleaved TypeScript and core layouts of `board`, and
 * the host calls one core layout made. Every timed core round must be one the
 * core answered, with nothing reported, or the round timed the TypeScript.
 */
function timedAgainstCore(board: WebLayoutBoard, real: WebCore, rounds = 15) {
  const { core, tally } = countedCore(real)
  const browser = createBrowserMeasureText()
  let asked = 0
  const counted = describeMeasure(
    (text, font) => {
      asked += 1
      return browser(text, font)
    },
    { kind: 'host' },
  )
  for (let i = 0; i < 3; i += 1) {
    layOut(board, browser)
    layOut(board, counted, core)
  }
  const ts: number[] = []
  const rust: number[] = []
  const answeredBefore = tally.answered
  for (let i = 0; i < rounds; i += 1) {
    let start = performance.now()
    layOut(board, browser)
    ts.push(performance.now() - start)
    asked = 0
    start = performance.now()
    layOut(board, counted, core)
    rust.push(performance.now() - start)
  }
  expect(tally.reports, board.name).toEqual([])
  expect(tally.answered - answeredBefore, board.name).toBe(rounds)
  return {
    tsMs: median(ts),
    rustMs: median(rust),
    asked,
    answered: tally.answered - answeredBefore,
  }
}

describe.runIf(RUN)('the browser measurer as a host import: what it costs, built', () => {
  it('times each board through the real core against the TypeScript', {
    timeout: 120_000,
  }, async () => {
    // lazy-import: the module names the artifact, which a person without the Rust toolchain has not built
    const { loadWebCore } = await import('./layout-core-source.js')
    const real = await loadWebCore(fetch)
    await ensureViewerFontLoaded()
    const rows = webLayoutBoards().map((board) => {
      const { tsMs, rustMs, asked, answered } = timedAgainstCore(board, real)
      return {
        board: board.name,
        'core answers': answered,
        'host calls': asked,
        'ts ms': tsMs.toFixed(2),
        'core ms': rustMs.toFixed(2),
        'core / ts': (rustMs / tsMs).toFixed(2),
      }
    })
    expect(rows.every((row) => row['host calls'] > 0)).toBe(true)
    console.table(rows)
    console.info(JSON.stringify(rows))
  })
})
