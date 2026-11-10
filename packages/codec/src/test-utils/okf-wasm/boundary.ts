import type { Core, CoreGlue } from '@kamiazya/whiteboard-core-wasm'
import { coreFrom } from '@kamiazya/whiteboard-core-wasm'
import { type OkfMismatch, okfCodec } from '../../okf/okf-core.js'
import { parseOkf } from '../../okf/parse.js'
import type { OkfMarkdownDocument } from '../../okf/schema.js'
import { serializeOkf } from '../../okf/serialize.js'

/**
 * The OKF boundary's instrument (ADR-0054 step 6, QR-22b and QR-22c): what one
 * `parseOkf` and one `serializeOkf` cost through the Rust core against the
 * TypeScript they replace, per size of document, and how far the instance's
 * linear memory grows to answer the largest.
 *
 * Each class is first answered by both in `differential` with any difference
 * thrown, so no ratio is quoted for a port that answers differently. The wasm
 * exports are counted: the TypeScript batches must make none and the Rust
 * batches exactly one per document, so a baseline that quietly went through
 * Rust fails instead of reporting a ratio near one.
 */

/** `glue` with the OKF exports counted and the instance's memory kept. */
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
    okf_parse(text, mark) {
      calls += 1
      return glue.okf_parse(text, mark)
    },
    okf_serialize(frontmatter) {
      calls += 1
      return glue.okf_serialize(frontmatter)
    },
  }
  return {
    glue: instrumented,
    calls: () => calls,
    memoryBytes: () => memory?.buffer.byteLength ?? Number.NaN,
  }
}

/** One size class: the documents one iteration reads or writes, in order. */
export interface DocumentClass {
  readonly name: string
  readonly docs: readonly OkfMarkdownDocument[]
}

const words = (n: number, seed: number): string =>
  Array.from({ length: n }, (_, i) => `w${(i * 7919 + seed) % 997}`).join(' ')

const note = (i: number): OkfMarkdownDocument => ({
  frontmatter: { type: 'note', title: `Note ${i}`, tags: ['a', `t${i % 7}`, 'plan'] },
  body: `# Note ${i}\n\n${words(150, i)}\n`,
})

const faceted = (i: number): OkfMarkdownDocument => ({
  frontmatter: {
    type: 'issue',
    title: `Issue ${i}`,
    description: words(30, i),
    facets: Object.fromEntries(
      Array.from({ length: 20 }, (_, k) => [
        `ex.f${k}/v1`,
        {
          status: k % 2 === 0 ? 'open' : 'closed',
          weight: k * 1.5,
          notes: [words(5, k), words(4, i)],
        },
      ]),
    ),
  },
  body: words(300, i),
})

/** The size classes the switch decision turns on, all deterministic. */
export function documentClasses(): readonly DocumentClass[] {
  return [
    {
      name: 'note (title, 3 tags, 1 KB body), x50',
      docs: Array.from({ length: 50 }, (_, i) => note(i)),
    },
    {
      name: 'faceted (20 facets, ~3 KB frontmatter), x20',
      docs: Array.from({ length: 20 }, (_, i) => faceted(i)),
    },
    {
      name: 'long body (200 KB body, small frontmatter)',
      docs: [
        { frontmatter: { type: 'note', title: 'Long' }, body: words(40_000, 1).slice(0, 200_000) },
      ],
    },
    {
      name: 'large frontmatter (~150 KB: 12k tags)',
      docs: [
        {
          frontmatter: { type: 'note', tags: Array.from({ length: 12_000 }, (_, i) => `tag-${i}`) },
          body: '',
        },
      ],
    },
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

/** One class and one operation; times are milliseconds per iteration (every document once). */
export interface ClassResult {
  readonly name: string
  readonly op: 'parseOkf' | 'serializeOkf'
  readonly docs: number
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
  readonly classes?: readonly DocumentClass[]
}

type Timed = (iterations: number, run: () => void) => number

/** Every class read and written by both in `differential`, any difference thrown. */
function assertAgree(core: Core, cls: DocumentClass): readonly string[] {
  const differential = okfCodec({
    okf: core,
    impl: { parseOkf: 'differential', serializeOkf: 'differential' },
    onMismatch: (m: OkfMismatch) => {
      if (m.kind === 'differs') throw new Error(`${cls.name}: ${m.fn} differs from the TypeScript`)
      throw new Error(`${cls.name}: the core declined ${m.fn}, so nothing would be measured`)
    },
  })
  const texts = cls.docs.map((doc) => differential.serializeOkf(doc))
  for (const text of texts) differential.parseOkf(text)
  return texts
}

function batchSize(timed: Timed, run: () => void, batchMs: number): number {
  let iterations = 1
  while (timed(iterations, run) * iterations < batchMs && iterations < 1 << 20) iterations *= 2
  return iterations
}

function measureOne(
  options: BoundaryOptions,
  cls: DocumentClass,
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
  const expected = rounds * iterations * cls.docs.length
  if (counted !== expected) {
    throw new Error(
      `${cls.name} ${op}: ${counted} counted wasm calls, expected ${expected}; the TypeScript baseline may not be TypeScript`,
    )
  }
  return {
    name: cls.name,
    op,
    docs: cls.docs.length,
    bytes,
    iterationsPerBatch: iterations,
    ts: spread(tsMs),
    rust: spread(rustMs),
    ratio: spread(rustMs.map((r, i) => r / (tsMs[i] as number))),
    memoryBytes: instrumented.memoryBytes(),
  }
}

/** Every class of `options`, or of `documentClasses()`, read and written by both. */
export function measureBoundary(options: BoundaryOptions): ClassResult[] {
  const { core } = options
  return (options.classes ?? documentClasses()).flatMap((cls) => {
    const texts = assertAgree(core, cls)
    const bytes = texts.reduce((n, t) => n + t.length, 0)
    const each =
      <T>(items: readonly T[], call: (item: T) => unknown) =>
      () => {
        for (const item of items) call(item)
      }
    const parse = { ts: each(texts, parseOkf), rust: each(texts, (t) => core.parseOkf(t)) }
    const serialize = {
      ts: each(cls.docs, serializeOkf),
      rust: each(cls.docs, (d) => core.serializeOkf(d)),
    }
    return [
      measureOne(options, cls, 'parseOkf', parse, bytes),
      measureOne(options, cls, 'serializeOkf', serialize, bytes),
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
    '| documents | call | text per iteration | TypeScript | Rust (shim + wasm) | Rust/TS (<1: Rust faster) | linear memory after |',
    '|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n')
}
