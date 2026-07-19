import { test as fcTest } from '@fast-check/vitest'
import * as fc from 'fast-check'

export { fc, fcTest }

// Generic over T (fast-check's own `Parameters<T>` type parameter, used for
// `examples: T[]`) so a caller supplying `examples` for a specific arbitrary
// tuple gets that tuple checked against the schema. Defaulting T to `never`
// (rather than fast-check's own `void` default) keeps every existing
// `withDefaults()` call assignable to any `fc.Parameters<Ts>` the caller's
// arbitrary tuple needs, since `never[]` is a subtype of every array type.
export function withDefaults<T = never>(override?: fc.Parameters<T>): fc.Parameters<T> {
  return { numRuns: 200, ...override }
}
