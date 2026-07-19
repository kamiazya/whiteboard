import { test as fcTest } from '@fast-check/vitest'
import * as fc from 'fast-check'

export { fc, fcTest }

// T defaults to `never` (not `unknown`): fc.Parameters<never> is assignable to
// every fc.Parameters<[...]> at zero-config call sites, while callers passing
// type-bearing options like `examples` name T explicitly.
export function withDefaults<T = never>(override?: fc.Parameters<T>): fc.Parameters<T> {
  return { numRuns: 200, ...override }
}
