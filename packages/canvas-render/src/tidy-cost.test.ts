import { describe, expect, it, vi } from 'vitest'
import { tidyNodes as recursiveTidyNodes } from './test-utils/tidy-reference/tidy.js'
import { tidyNodes } from './tidy.js'

// Work, not wall time: every collision test tidy makes goes through
// `overlapsWithMargin`, so counting its calls is exact and load-independent.
const overlapChecks = vi.hoisted(() => ({ count: 0 }))
// Frame membership asks one geometric question, `fullyContains`, so its
// call count is the same kind of exact, load-independent measure for the
// nesting walk.
const containmentChecks = vi.hoisted(() => ({ count: 0 }))
// Each level of the nesting walk does work in proportion to the nodes it
// holds — its units are built from them, and its margin and its grow read
// them — so the nodes handed to `buildUnits`, summed over every level, are
// the walk's own measure. A chain has a level per frame, each holding every
// frame inside it.
const levelVisits = vi.hoisted(() => ({ count: 0 }))
// The deepest stack either question was asked at, read by `deepestStackFor`.
const STACK_SAMPLE_EVERY = 997
const stackDepth = vi.hoisted(() => ({
  max: 0,
  calls: 0,
  sample(every: number) {
    if (this.calls++ % every !== 0) return
    const frames = (new Error().stack ?? '').split('\n').length
    if (frames > this.max) this.max = frames
  },
}))

vi.mock('./layout/edges/edge-rules.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./layout/edges/edge-rules.js')>()
  return {
    ...actual,
    fullyContains: (...args: Parameters<typeof actual.fullyContains>) => {
      containmentChecks.count++
      stackDepth.sample(STACK_SAMPLE_EVERY)
      return actual.fullyContains(...args)
    },
  }
})

vi.mock('./tidy-units.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tidy-units.js')>()
  return {
    ...actual,
    overlapsWithMargin: (...args: Parameters<typeof actual.overlapsWithMargin>) => {
      overlapChecks.count++
      stackDepth.sample(STACK_SAMPLE_EVERY)
      return actual.overlapsWithMargin(...args)
    },
    buildUnits: (...args: Parameters<typeof actual.buildUnits>) => {
      levelVisits.count += args[0].length
      return actual.buildUnits(...args)
    },
  }
})

describe('tidyNodes cost', () => {
  it('separates a stack of identical boxes within its overlap-check ceiling', () => {
    // Identical boxes at one spot are the worst case for the hop: each box
    // has to clear every box already placed in the same row.
    const n = 200
    const nodes = Array.from({ length: n }, (_, i) => ({
      id: `n${String(i).padStart(3, '0')}`,
      frame: false,
      x: 0,
      y: 0,
      width: 100,
      height: 60,
    }))
    overlapChecks.count = 0
    const moves = tidyNodes(nodes)

    // The subject is present: the stack really was pulled apart, so the
    // count below measures separation work rather than an early exit.
    expect(moves).toHaveLength(n - 1)
    // Was 1_393_998 — cubic in n (182k at 100, 9.2M at 400) — while each
    // hop re-scanned every placed box. Measured 60_698 after.
    expect(overlapChecks.count).toBeLessThanOrEqual(3 * n * n)
  })
})

/**
 * `n` frames, each strictly inside the next, listed innermost first — the
 * document order that makes "is any other frame around this one" scan
 * furthest before it answers.
 */
function nestedChain(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `f${String(i).padStart(4, '0')}`,
    frame: true,
    x: -i * 10,
    y: -i * 10,
    width: 100 + i * 20,
    height: 100 + i * 20,
  }))
}

describe('tidyNodes cost on nested frames', () => {
  it('walks a chain of nested frames in quadratic containment checks', () => {
    const counts = [25, 50, 100, 200].map((n) => {
      containmentChecks.count = 0
      tidyNodes(nestedChain(n))
      return containmentChecks.count
    })
    // The subject is present: a chain of 25 asks the question at all.
    expect(counts[0]).toBeGreaterThan(25)
    for (const [i, n] of [25, 50, 100, 200].entries()) {
      expect(counts[i]).toBeLessThanOrEqual(4 * n * n)
    }
  })

  it('tidies the deepest chain a canvas can hold in quadratic containment checks', () => {
    const n = 2000
    containmentChecks.count = 0
    tidyNodes(nestedChain(n))
    // Was 323s of wall time on one tidy; 3.3s after, with these mocks off.
    expect(containmentChecks.count).toBeLessThanOrEqual(4 * n * n)
  }, 120_000)

  // 2000 identical frames nest too: the document-order tie-break puts each
  // inside every one before it, so they cost what a chain does.
  it.each([
    ['a chain of nested frames', nestedChain],
    ['identical frames', identicalFrames],
  ])(
    'bounds the walk over %s as deep as a canvas holds',
    (_, board) => {
      const n = 2000
      containmentChecks.count = 0
      levelVisits.count = 0
      tidyNodes(board(n))
      // The subject is present: the walk went deep rather than stopping at
      // the top level.
      expect(levelVisits.count).toBeGreaterThan(100 * n)
      // Two settling passes, each asking every frame about every other and
      // opening a level per frame: 1.2e7 containment checks (1.4e7 for
      // identical frames) and 4_002_000 level visits: 3.8s of wall time on
      // the chain with these mocks off.
      expect(containmentChecks.count).toBeLessThanOrEqual(4 * n * n)
      expect(levelVisits.count).toBeLessThanOrEqual(n * (n + 1))
    },
    120_000,
  )

  it('walks the nesting without spending call stack per level', () => {
    // A canvas chooses how deep its frames go, so the stack the walk needs
    // must not grow with the depth. Measured as a frame COUNT at the deepest
    // geometric question the walk asks, not as stack headroom: how many bytes
    // a frame takes changes with the engine tier and with instrumentation
    // (Stryker), and a headroom comparison that held locally failed under
    // both. A count is the same number everywhere.
    const shallow = deepestStackFor(() => tidyNodes(nestedChain(50)))
    const deep = deepestStackFor(() => tidyNodes(nestedChain(400)))
    expect(deep - shallow).toBeLessThanOrEqual(STACK_SLACK_FRAMES)
    // The instrument can see a walk that spends a frame per level: the
    // frozen recursive tidy goes measurably deeper on a deeper chain.
    const recursiveGrowth =
      deepestStackFor(() => recursiveTidyNodes(nestedChain(200))) -
      deepestStackFor(() => recursiveTidyNodes(nestedChain(50)))
    expect(recursiveGrowth).toBeGreaterThan(150)
  }, 120_000)
})

/** `n` frames on one box, which nest by document order alone. */
function identicalFrames(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `f${String(i).padStart(4, '0')}`,
    frame: true,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  }))
}

/** Frames a deeper chain may add without the walk recursing per level. */
const STACK_SLACK_FRAMES = 10

/**
 * The deepest call stack, in frames, at which `fn` asked a containment or
 * overlap question. Sampled on one call in `STACK_SAMPLE_EVERY`, because
 * reading a stack is dear and the walk asks millions; a recursion asks most
 * of them at depth, so the sample still finds it.
 */
function deepestStackFor(fn: () => unknown): number {
  const limit = Error.stackTraceLimit
  Error.stackTraceLimit = Number.POSITIVE_INFINITY
  stackDepth.max = 0
  stackDepth.calls = 0
  try {
    fn()
  } finally {
    Error.stackTraceLimit = limit
  }
  return stackDepth.max
}
