import { describe, expect, it } from 'vitest'
import source from './test-utils/document-backend-contract.ts?raw'

/**
 * The contract's ceilings are named constants because they are raised for one
 * reason — a loaded run measured a delivery past them — and a literal left
 * beside the constant is the one site that raise misses, usually in the
 * slowest case.
 */
describe('document-backend-contract ceilings', () => {
  it('declares every timeout through a named constant, never a numeric literal', () => {
    const literals = source.match(/\btimeout:\s*[\d_]+/g) ?? []

    expect(literals).toEqual([])
  })

  it('finds the timeouts it is guarding', () => {
    // A pattern that stopped matching would otherwise pass the check above over nothing.
    expect(source.match(/\btimeout:\s*[A-Z_]+_MS\b/g)?.length ?? 0).toBeGreaterThan(10)
  })
})
