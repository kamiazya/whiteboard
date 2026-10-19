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

vi.mock('./layout/edges/edge-rules.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./layout/edges/edge-rules.js')>()
  return {
    ...actual,
    fullyContains: (...args: Parameters<typeof actual.fullyContains>) => {
      containmentChecks.count++
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
      return actual.overlapsWithMargin(...args)
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

  it('walks the nesting without spending call stack per level', () => {
    // A canvas chooses how deep its frames go, so the walk must not need a
    // stack frame per level. Run with almost no stack left, a chain the
    // recursive walk cannot finish is one this one must. The subject's chain
    // is deeper than the spare stack holds even one trivial frame per level,
    // so a leaner recursion than the reference's overflows there too; the
    // reference's premise needs only the shorter one, and pays its cubic
    // walk on fewer levels before it overflows.
    expect(() => withLittleStack(() => recursiveTidyNodes(nestedChain(300)))).toThrow(RangeError)
    expect(() => withLittleStack(() => tidyNodes(nestedChain(1000)))).not.toThrow()
  }, 60_000)
})

/**
 * Run `fn` with roughly `SPARE_FRAMES` trivial frames of stack left, found by
 * probing how deep this realm lets a trivial function recurse rather than by
 * assuming a stack size. Measured here: the explicit-stack walk finishes with
 * 50 spare, and on a 300-frame chain the reference recursion (two frames a
 * level) overflows with up to 1200 spare, so 400 is a factor of three from
 * either edge.
 */
const SPARE_FRAMES = 400
function withLittleStack(fn: () => unknown): void {
  const probe = (depth: number): number => {
    try {
      return probe(depth + 1)
    } catch {
      return depth
    }
  }
  const limit = probe(0)
  const descend = (depth: number): void => {
    if (depth > 0) {
      descend(depth - 1)
      return
    }
    fn()
  }
  descend(limit - SPARE_FRAMES)
}
