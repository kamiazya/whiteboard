import { test as fcTest } from '@fast-check/vitest'
import * as fc from 'fast-check'

export { fc, fcTest }

/**
 * The ONE copy of the prelude that is not a re-export of
 * `@kamiazya/whiteboard-model/test-utils`, and deliberately so: this package
 * depends on `loro-crdt` and nothing else, which is the claim
 * `package-history.md` makes about it, and a devDependency on `model` for
 * three lines would be the first exception to it.
 *
 * `fast-check-prelude-check.test.ts` in `tools/arch-lint` allowlists this
 * file by name and fails if a THIRTEENTH copy appears, so the divergence is
 * a decision on the record rather than the start of another drift.
 *
 * Keep the signature identical to the shared one.
 */
export function withDefaults<T = never>(override?: fc.Parameters<T>): fc.Parameters<T> {
  return { numRuns: 200, ...override }
}
