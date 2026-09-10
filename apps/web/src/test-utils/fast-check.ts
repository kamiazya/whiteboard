import { test as fcTest } from '@fast-check/vitest'
import * as fc from 'fast-check'

export { fc, fcTest }

/**
 * Generic in the property's own tuple so an override may carry `examples`,
 * which `fc.Parameters<never>` types as `never[]` and refuses.
 *
 * That matters most at this layer: a browser property's run count is small
 * by budget (`test-layer-selection`), so an arrangement that decides whether
 * the property asserts anything cannot be left to the draws alone. Pinning
 * it as an example runs it every time and is not a pinned SEED — the random
 * draws still explore, and the example is the case, not the RNG state.
 */
export function withDefaults<T = never>(override?: fc.Parameters<T>): fc.Parameters<T> {
  return { numRuns: 200, ...override }
}
