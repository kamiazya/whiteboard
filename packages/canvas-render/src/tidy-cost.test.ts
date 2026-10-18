import { describe, expect, it, vi } from 'vitest'
import { tidyNodes } from './tidy.js'

// Work, not wall time: every collision test tidy makes goes through
// `overlapsWithMargin`, so counting its calls is exact and load-independent.
const overlapChecks = vi.hoisted(() => ({ count: 0 }))

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
    // Measured 1_393_998 — cubic in n (182k at 100, 9.2M at 400).
    expect(overlapChecks.count).toBeLessThanOrEqual(1_393_998)
  })
})
