import { test as fcTest } from '@fast-check/vitest'
import * as fc from 'fast-check'

export { fc, fcTest }

export function withDefaults(override?: fc.Parameters<never>): fc.Parameters<never> {
  return { numRuns: 200, ...override }
}
