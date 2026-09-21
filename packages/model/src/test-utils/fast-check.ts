import { test as fcTest } from '@fast-check/vitest'
import * as fc from 'fast-check'

export { fc, fcTest }

/**
 * The one property-test prelude for this repo, re-exported by every other
 * package's `test-utils/fast-check.ts` so a change to the discipline —
 * `numRuns`, a reporter, a `verbose` default — has ONE place to reach.
 *
 * It lives here because `model` is the only package all the others already
 * depend on, and because `test-utils/index.ts` was built for exactly this
 * ("without duplicating arbitraries per package"). `fast-check` is a
 * devDependency, which `tools/arch-lint`'s allowed-third-party check does
 * not inspect at all, so this needs no entry in `allowedThirdParty`.
 *
 * `numRuns: 200` is the budget in the `test-layer-selection` skill. A
 * property that needs more says so at its own call site; a property that is
 * vacuous is answered with a denser generator, never with more runs.
 *
 * T defaults to `never` rather than `unknown`: `fc.Parameters<never>` is
 * assignable to every `fc.Parameters<[...]>` at zero-config call sites, while
 * a caller passing a type-bearing option like `examples` names T explicitly.
 * Two packages worked that out independently and eleven did not, which is
 * what a copied prelude costs — a caller in one of those eleven that reached
 * for `examples` was refused by a signature nobody had decided on.
 */
export function withDefaults<T = never>(override?: fc.Parameters<T>): fc.Parameters<T> {
  return { numRuns: 200, ...override }
}
