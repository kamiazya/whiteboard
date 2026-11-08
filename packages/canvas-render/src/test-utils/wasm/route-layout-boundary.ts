import type { Core } from '@kamiazya/whiteboard-core-wasm'
import type { EdgeRoutingStyle } from '@kamiazya/whiteboard-model'
import { type CoreMismatch, type LayoutCore, routeLayout } from '../../layout/edges/layout-core.js'
import { createRoutingBudget } from '../../layout/edges/routing-budget.js'
import {
  clusteredLayout,
  latticeLayouts,
  ROUTING_CORPUS,
  type RoutingCase,
  stackedFrameLayouts,
  syntheticLayouts,
} from '../routing-corpus.js'

/**
 * The routing boundary's instrument (ADR-0054 step 5, QR-22b): what one
 * `routeLayout` costs through the Rust core against the TypeScript it
 * replaces, and how much of the Rust side is the boundary (encode, the copy
 * into and out of wasm memory, decode) rather than the routing.
 *
 * The TypeScript side is `routeLayout(undefined, …)` over the real modules,
 * so it is only the TypeScript where no vitest alias replaces `edge-router`,
 * `spatial-edges` or `grid-route` with their Rust shims: the node bench
 * project and the bundle `scripts/route-layout-boundary.mjs` builds, which
 * has no alias. `measureBoundary` also checks it from the inside — the
 * TypeScript loop makes no wasm call and the Rust loop makes exactly one per
 * layout — so a baseline that quietly routed through Rust fails here
 * instead of reporting a ratio near one.
 */

/** Everything the boundary reads of the glue. */
export interface RoutingGlue {
  edge_route_layout(input: Float64Array): Float64Array
  /** wasm-bindgen's synchronous init, which answers the instance's exports. */
  initSync(options: { module: BufferSource | WebAssembly.Module }): {
    readonly memory: WebAssembly.Memory
  }
}

/**
 * `glue` with `edge_route_layout` counted and its inputs kept, so the wasm
 * call can be replayed without the marshalling around it.
 */
export function instrumentGlue<G extends RoutingGlue>(glue: G) {
  let calls = 0
  let kept: Float64Array[] | undefined
  let memory: WebAssembly.Memory | undefined
  const instrumented: G = {
    ...glue,
    initSync(options: { module: BufferSource | WebAssembly.Module }) {
      const exports = glue.initSync(options)
      memory = exports.memory
      return exports
    },
    edge_route_layout(input: Float64Array) {
      calls += 1
      kept?.push(input)
      return glue.edge_route_layout(input)
    },
  }
  return {
    glue: instrumented,
    calls: () => calls,
    /**
     * The instance's linear memory in bytes. It only ever grows, so read after
     * a board it is the peak so far.
     */
    memoryBytes: () => {
      if (memory === undefined) throw new Error('the glue was never initialised')
      return memory.buffer.byteLength
    },
    capture<T>(run: () => T): { result: T; inputs: Float64Array[] } {
      kept = []
      try {
        const result = run()
        return { result, inputs: kept }
      } finally {
        kept = undefined
      }
    },
    replay: (inputs: readonly Float64Array[]) => {
      for (const input of inputs) glue.edge_route_layout(input)
    },
  }
}

/** One size class: the boards a single iteration routes, in order. */
export interface Board {
  readonly name: string
  readonly cases: readonly RoutingCase[]
}

const edgeCount = (b: Board) => b.cases.reduce((n, c) => n + c.edges.length, 0)
const nodeCount = (b: Board) => b.cases.reduce((n, c) => n + c.nodes.length, 0)

/** The size classes the switch decision turns on, all deterministic. */
export function boundaryBoards(): readonly Board[] {
  const clustered = clusteredLayout({ clusters: 12, nodesPerCluster: 12, edgesPerCluster: 16 })
  return [
    { name: 'corpus (5 reported boards)', cases: ROUTING_CORPUS },
    { name: 'synthetic (30 boards of 2-5 nodes)', cases: syntheticLayouts(30) },
    {
      name: 'clustered, 3 clusters x 8 nodes',
      cases: [clusteredLayout({ clusters: 3, nodesPerCluster: 8, edgesPerCluster: 15 })],
    },
    { name: 'lattice (12 boards of 5-8 nodes)', cases: latticeLayouts(12) },
    { name: 'stacked frames (12 boards)', cases: stackedFrameLayouts(12) },
    { name: 'clustered, 12 clusters x 12 nodes', cases: [clustered] },
    {
      name: 'clustered 12x12, nodes only (no edges)',
      cases: [{ ...clustered, name: 'no edges', edges: [] }],
    },
  ]
}

const styleOf = (style: EdgeRoutingStyle) => () => style

export function routeBoard(core: LayoutCore | undefined, board: Board, style: EdgeRoutingStyle) {
  const s = styleOf(style)
  for (const c of board.cases) {
    routeLayout(core, c.nodes, c.edges, s, undefined, createRoutingBudget(), [])
  }
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

/** One board's measurement; times are milliseconds per iteration (every case of the board once). */
export interface BoardResult {
  readonly name: string
  readonly layouts: number
  readonly nodes: number
  readonly edges: number
  readonly iterationsPerBatch: number
  readonly ts: Spread
  readonly rust: Spread
  /** The wasm call alone, replayed on the inputs the shim built: routing plus the copy across. */
  readonly wasm: Spread
  /** Rust minus the wasm call: encode, decode and the shim around them. */
  readonly marshal: Spread
  /** Per round, rust / ts. */
  readonly ratio: Spread
  /** Per round, marshal / rust. */
  readonly marshalShare: Spread
  /** Linear memory after this board was checked, warmed and timed: the peak so far. */
  readonly memoryBytes: number
}

export interface BoundaryOptions {
  readonly core: Core
  readonly instrumented: ReturnType<typeof instrumentGlue>
  readonly now: () => number
  readonly rounds?: number
  /** A batch is repeated until it takes about this long, so a coarse clock still resolves it. */
  readonly batchMs?: number
  readonly style?: EdgeRoutingStyle
  readonly boards?: readonly Board[]
}

type Timed = (iterations: number, run: () => void) => number

/**
 * Iterations per batch: doubled until one batch is long enough for the clock
 * to resolve (a browser's is coarsened to 100us), then scaled to `batchMs`.
 */
function batchSize(timed: Timed, run: () => void, batchMs: number): number {
  let probe = 1
  let probeMs = timed(probe, run) * probe
  while (probeMs < batchMs / 10 && probe < 1 << 24) {
    probe *= 2
    probeMs = timed(probe, run) * probe
  }
  return Math.max(1, Math.ceil((probe * batchMs) / Math.max(probeMs, 1e-6)))
}

/** Each runner timed once per round, the order rotating so a drift lands on all of them. */
function interleave(rounds: number, runners: readonly (() => void)[]): void {
  for (let round = 0; round < rounds; round++) {
    for (let k = 0; k < runners.length; k++) (runners[(k + round) % runners.length] as () => void)()
  }
}

interface Runners {
  readonly runTs: () => void
  readonly runRust: () => void
  readonly runWasm: () => void
}

/**
 * The three loops for one board, after checking that the two sides agree and
 * that Rust makes one wasm call per layout, and warming them.
 */
function prepare(options: BoundaryOptions, board: Board): Runners {
  const { core, instrumented } = options
  const style = options.style ?? 'straight'
  const rust: LayoutCore = { routing: core, impl: { routeLayout: 'rust' } }
  const mismatches: CoreMismatch[] = []
  const differential: LayoutCore = {
    routing: core,
    impl: { routeLayout: 'differential' },
    onMismatch: (m) => mismatches.push(m),
  }
  const runTs = () => routeBoard(undefined, board, style)
  const runRust = () => routeBoard(rust, board, style)

  routeBoard(differential, board, style)
  if (mismatches.length > 0) {
    throw new Error(`${board.name}: the Rust core answers differently from the TypeScript`)
  }
  const { inputs } = instrumented.capture(runRust)
  if (inputs.length !== board.cases.length) {
    throw new Error(
      `${board.name}: ${inputs.length} wasm calls for ${board.cases.length} layouts, not one each`,
    )
  }
  const runWasm = () => instrumented.replay(inputs)
  for (let i = 0; i < 3; i++) {
    runTs()
    runRust()
    runWasm()
  }
  return { runTs, runRust, runWasm }
}

/**
 * One board, TypeScript against Rust, interleaved. Throws after timing if the
 * Rust batches did not make exactly one counted wasm call per layout, which
 * also proves the TypeScript batches made none.
 */
function measureBoard(options: BoundaryOptions, board: Board): BoardResult {
  const { instrumented, now } = options
  const rounds = options.rounds ?? 7
  const { runTs, runRust, runWasm } = prepare(options, board)
  const timed: Timed = (iterations, run) => {
    const start = now()
    for (let i = 0; i < iterations; i++) run()
    return (now() - start) / iterations
  }
  const iterations = batchSize(timed, runTs, options.batchMs ?? 25)

  const tsMs: number[] = []
  const rustMs: number[] = []
  const wasmMs: number[] = []
  const callsBefore = instrumented.calls()
  interleave(rounds, [
    () => tsMs.push(timed(iterations, runTs)),
    () => rustMs.push(timed(iterations, runRust)),
    () => wasmMs.push(timed(iterations, runWasm)),
  ])
  // Counted calls are the shim's alone (the replays bypass the counter).
  const expectedCalls = rounds * iterations * board.cases.length
  const counted = instrumented.calls() - callsBefore
  if (counted !== expectedCalls) {
    throw new Error(
      `${board.name}: ${counted} counted wasm calls in the Rust batches, expected ${expectedCalls}; the TypeScript baseline may not be TypeScript`,
    )
  }
  return {
    ...summarize(board, iterations, { tsMs, rustMs, wasmMs }),
    memoryBytes: instrumented.memoryBytes(),
  }
}

function summarize(
  board: Board,
  iterations: number,
  m: { tsMs: number[]; rustMs: number[]; wasmMs: number[] },
): Omit<BoardResult, 'memoryBytes'> {
  const marshal = m.rustMs.map((r, i) => r - (m.wasmMs[i] as number))
  return {
    name: board.name,
    layouts: board.cases.length,
    nodes: nodeCount(board),
    edges: edgeCount(board),
    iterationsPerBatch: iterations,
    ts: spread(m.tsMs),
    rust: spread(m.rustMs),
    wasm: spread(m.wasmMs),
    marshal: spread(marshal),
    ratio: spread(m.rustMs.map((r, i) => r / (m.tsMs[i] as number))),
    marshalShare: spread(marshal.map((x, i) => x / (m.rustMs[i] as number))),
  }
}

/** Every board of `options`, or of `boundaryBoards()`, measured by `measureBoard`. */
export function measureBoundary(options: BoundaryOptions): BoardResult[] {
  return (options.boards ?? boundaryBoards()).map((board) => measureBoard(options, board))
}

/** What the instance's linear memory does when one board is routed again and again. */
export interface MemorySteadyState {
  readonly board: string
  readonly repeats: number
  readonly before: number
  readonly after: number
}

/**
 * Routes `board` through Rust `repeats` more times after everything else has
 * run. Linear memory never shrinks, so a long-lived tab's growth is whatever
 * this leaves above `before`; zero says repeated layouts reuse what the first
 * one grew.
 */
export function memorySteadyState(
  options: BoundaryOptions,
  board: Board,
  repeats = 20,
): MemorySteadyState {
  const rust: LayoutCore = { routing: options.core, impl: { routeLayout: 'rust' } }
  const before = options.instrumented.memoryBytes()
  for (let i = 0; i < repeats; i++) routeBoard(rust, board, options.style ?? 'straight')
  return { board: board.name, repeats, before, after: options.instrumented.memoryBytes() }
}

/** The measurement as a markdown table. */
export function formatBoundary(runtime: string, results: readonly BoardResult[]): string {
  const f = (s: Spread, digits = 3) =>
    `${s.median.toFixed(digits)} [${s.min.toFixed(digits)}-${s.max.toFixed(digits)}]`
  const pct = (s: Spread) =>
    `${(s.median * 100).toFixed(0)}% [${(s.min * 100).toFixed(0)}-${(s.max * 100).toFixed(0)}]`
  const rows = results.map(
    (r) =>
      `| ${r.name} | ${r.layouts}/${r.nodes}/${r.edges} | ${f(r.ts)} | ${f(r.rust)} | ${f(r.wasm)} | ${f(r.marshal)} | ${r.ratio.median.toFixed(2)} [${r.ratio.min.toFixed(2)}-${r.ratio.max.toFixed(2)}] | ${pct(r.marshalShare)} | ${(r.memoryBytes / 2 ** 20).toFixed(2)} |`,
  )
  return [
    `${runtime}: ms per iteration, median [min-max] over rounds`,
    '| board | layouts/nodes/edges | TypeScript | Rust (total) | wasm call | boundary (Rust - wasm call) | Rust/TS (<1: Rust faster) | boundary share of Rust | wasm memory after (MiB) |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n')
}
