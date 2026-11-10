import type { Core, CoreGlue } from '@kamiazya/whiteboard-core-wasm'
import { coreFrom } from '@kamiazya/whiteboard-core-wasm'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { parseSpatial } from '../../spatial/parse.js'
import { serializeSpatial } from '../../spatial/serialize.js'

/**
 * The JSON Canvas boundary's instrument (ADR-0054 step 6, QR-22b and QR-22c):
 * what one `parseSpatial` and one `serializeSpatial` cost through the Rust core
 * against the TypeScript they replace, per size of canvas, and how far the
 * instance's linear memory grows to answer the largest.
 *
 * Each class is first answered by both and any difference thrown, so no ratio
 * is quoted for a port that answers differently. The wasm exports are counted:
 * the TypeScript batches must make none and the Rust batches exactly one per
 * canvas, so a baseline that quietly went through Rust fails instead of
 * reporting a ratio near one.
 */

/** `glue` with the JSON Canvas exports counted and the instance's memory kept. */
export function instrumentGlue(glue: CoreGlue) {
  let calls = 0
  let memory: { readonly buffer: ArrayBufferLike } | undefined
  const instrumented: CoreGlue = {
    ...glue,
    initSync(input) {
      const exports = glue.initSync(input) as { memory?: { buffer: ArrayBufferLike } }
      memory = exports.memory
      return exports
    },
    json_canvas_parse(text) {
      calls += 1
      return glue.json_canvas_parse(text)
    },
    json_canvas_serialize(canvas, strict) {
      calls += 1
      return glue.json_canvas_serialize(canvas, strict)
    },
  }
  return {
    glue: instrumented,
    calls: () => calls,
    memoryBytes: () => memory?.buffer.byteLength ?? Number.NaN,
  }
}

/** One size class: the canvases one iteration reads or writes, in order. */
export interface CanvasClass {
  readonly name: string
  readonly canvases: readonly SpatialCanvas[]
}

const words = (n: number, seed: number): string =>
  Array.from({ length: n }, (_, i) => `w${(i * 7919 + seed) % 997}`).join(' ')

/** A board of `nodes` text nodes in a grid, `edges` between neighbours, and a facet on every tenth. */
export function board(nodes: number, edges: number, seed = 0): SpatialCanvas {
  const columns = Math.max(1, Math.ceil(Math.sqrt(nodes)))
  return {
    nodes: Array.from({ length: nodes }, (_, i) => ({
      id: `n${i}`,
      x: (i % columns) * 220,
      y: Math.floor(i / columns) * 140,
      width: 200,
      height: 120,
      ...(i % 5 === 0 ? { color: String((i % 6) + 1) } : {}),
      ...(i % 10 === 0
        ? {
            facets: {
              'visual.shape/v0': { shape: 'rounded', weight: i * 0.5, notes: [words(3, i)] },
            },
          }
        : {}),
      resource: { mimeType: 'text/markdown', content: `# Node ${i}\n\n${words(12, i + seed)}` },
    })),
    edges: Array.from({ length: edges }, (_, i) => ({
      id: `e${i}`,
      from: { node: `n${i % nodes}`, side: 'right' as const },
      to: { node: `n${(i * 7 + 1) % nodes}`, side: 'left' as const, end: 'arrow' as const },
      ...(i % 4 === 0 ? { label: words(2, i) } : {}),
    })),
  }
}

/** The size classes the switch decision turns on, all deterministic. The largest is about as big as the writer takes: its wire, about 18% bigger than the text, must stay under the entry's 4 MiB. */
export function canvasClasses(): readonly CanvasClass[] {
  return [
    {
      name: 'small (3 nodes, 2 edges), x200',
      canvases: Array.from({ length: 200 }, (_, i) => board(3, 2, i)),
    },
    {
      name: 'typical (60 nodes, 80 edges, ~17 KiB), x10',
      canvases: Array.from({ length: 10 }, (_, i) => board(60, 80, i)),
    },
    { name: 'large (~700 KiB: 2,400 nodes, 3,000 edges)', canvases: [board(2400, 3000)] },
    { name: 'largest (~3.1 MiB: 11,000 nodes, 12,800 edges)', canvases: [board(11_000, 12_800)] },
  ]
}

/** The summary of one quantity over the rounds. */
export interface Spread {
  readonly median: number
  readonly min: number
  readonly max: number
}

function spread(values: readonly number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  const median =
    sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
  return { median, min: sorted[0] as number, max: sorted[sorted.length - 1] as number }
}

/** One class and one operation; times are milliseconds per iteration (every canvas once). */
export interface ClassResult {
  readonly name: string
  readonly op: 'parseSpatial' | 'serializeSpatial'
  readonly canvases: number
  readonly bytes: number
  readonly iterationsPerBatch: number
  readonly ts: Spread
  readonly rust: Spread
  /** Per round, rust / ts. */
  readonly ratio: Spread
  /** The instance's linear memory after this class, in bytes. */
  readonly memoryBytes: number
}

export interface BoundaryOptions {
  readonly core: Core
  readonly instrumented: ReturnType<typeof instrumentGlue>
  readonly now: () => number
  readonly rounds?: number
  /** A batch is repeated until it takes about this long, so a coarse clock still resolves it. */
  readonly batchMs?: number
  readonly classes?: readonly CanvasClass[]
}

type Timed = (iterations: number, run: () => void) => number

/** Every canvas of `cls` written and read by both, any difference thrown. */
function assertAgree(core: Core, cls: CanvasClass): readonly string[] {
  return cls.canvases.map((canvas) => {
    const text = serializeSpatial(canvas, 'extended')
    if (core.serializeSpatial(canvas, 'extended') !== text) {
      throw new Error(`${cls.name}: serializeSpatial differs from the TypeScript`)
    }
    const [rust, ts] = [core.parseSpatial(text), parseSpatial(text)]
    if (!rust.ok || !ts.ok || JSON.stringify(rust.value) !== JSON.stringify(ts.value)) {
      throw new Error(`${cls.name}: parseSpatial differs from the TypeScript`)
    }
    return text
  })
}

function batchSize(timed: Timed, run: () => void, batchMs: number): number {
  let iterations = 1
  while (timed(iterations, run) * iterations < batchMs && iterations < 1 << 20) iterations *= 2
  return iterations
}

function measureOne(
  options: BoundaryOptions,
  cls: CanvasClass,
  op: ClassResult['op'],
  runs: { ts: () => void; rust: () => void },
  bytes: number,
): ClassResult {
  const { instrumented, now } = options
  const rounds = options.rounds ?? 7
  const timed: Timed = (iterations, run) => {
    const start = now()
    for (let i = 0; i < iterations; i++) run()
    return (now() - start) / iterations
  }
  const iterations = batchSize(timed, runs.ts, options.batchMs ?? 25)
  const tsMs: number[] = []
  const rustMs: number[] = []
  const before = instrumented.calls()
  for (let r = 0; r < rounds; r++) {
    const order = r % 2 === 0 ? [runs.ts, runs.rust] : [runs.rust, runs.ts]
    for (const run of order) (run === runs.ts ? tsMs : rustMs).push(timed(iterations, run))
  }
  const counted = instrumented.calls() - before
  const expected = rounds * iterations * cls.canvases.length
  if (counted !== expected) {
    throw new Error(
      `${cls.name} ${op}: ${counted} counted wasm calls, expected ${expected}; the TypeScript baseline may not be TypeScript`,
    )
  }
  return {
    name: cls.name,
    op,
    canvases: cls.canvases.length,
    bytes,
    iterationsPerBatch: iterations,
    ts: spread(tsMs),
    rust: spread(rustMs),
    ratio: spread(rustMs.map((r, i) => r / (tsMs[i] as number))),
    memoryBytes: instrumented.memoryBytes(),
  }
}

/** Every class of `options`, or of `canvasClasses()`, read and written by both. */
export function measureBoundary(options: BoundaryOptions): ClassResult[] {
  const { core } = options
  return (options.classes ?? canvasClasses()).flatMap((cls) => {
    const texts = assertAgree(core, cls)
    const bytes = texts.reduce((n, t) => n + t.length, 0)
    const each =
      <T>(items: readonly T[], call: (item: T) => unknown) =>
      () => {
        for (const item of items) call(item)
      }
    const parse = { ts: each(texts, parseSpatial), rust: each(texts, (t) => core.parseSpatial(t)) }
    const write = {
      ts: each(cls.canvases, (c) => serializeSpatial(c, 'extended')),
      rust: each(cls.canvases, (c) => core.serializeSpatial(c, 'extended')),
    }
    return [
      measureOne(options, cls, 'parseSpatial', parse, bytes),
      measureOne(options, cls, 'serializeSpatial', write, bytes),
    ]
  })
}

/** Instantiates the core from `source` through the counted glue, timing the init. */
export function instrumentedCore(
  glue: CoreGlue,
  source: BufferSource | WebAssembly.Module,
  now: () => number,
) {
  const instrumented = instrumentGlue(glue)
  const start = now()
  const core = coreFrom(instrumented.glue, source)
  return { core, instrumented, initMs: now() - start, memoryAfterInit: instrumented.memoryBytes() }
}

/** The measurement as a markdown table. */
export function formatBoundary(
  runtime: string,
  init: { initMs: number; memoryAfterInit: number },
  results: readonly ClassResult[],
): string {
  const f = (s: Spread) => `${s.median.toFixed(3)} [${s.min.toFixed(3)}-${s.max.toFixed(3)}]`
  const mib = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MiB`
  const rows = results.map(
    (r) =>
      `| ${r.name} | ${r.op} | ${(r.bytes / 1024).toFixed(1)} KiB | ${f(r.ts)} | ${f(r.rust)} | ${r.ratio.median.toFixed(2)} [${r.ratio.min.toFixed(2)}-${r.ratio.max.toFixed(2)}] | ${mib(r.memoryBytes)} |`,
  )
  return [
    `${runtime}: init ${init.initMs.toFixed(1)} ms, linear memory ${mib(init.memoryAfterInit)} after init; ms per iteration, median [min-max] over rounds`,
    '| canvases | call | text per iteration | TypeScript | Rust (shim + wasm) | Rust/TS (<1: Rust faster) | linear memory after |',
    '|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n')
}
