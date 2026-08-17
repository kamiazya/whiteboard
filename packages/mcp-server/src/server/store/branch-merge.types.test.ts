import { expectTypeOf, it } from 'vitest'
import type { CreateBranchesRouterOptions } from '../routes/branches.js'
import type { PerformBranchMergeResult, PerformMergeHookResult } from './branch-merge.js'

// Compile-time only: routes/branches.ts's pluggable performMerge hook must
// stay assignable to the store module's result type — branches.ts imports
// PerformMergeHookResult rather than re-declaring it, and this test fails
// to compile the moment the two diverge.
// expectTypeOf is erased at runtime — `vitest run` always shows this file
// green regardless of whether the types actually match — so the guard is
// `pnpm typecheck`, not the test run. tsconfig.server.json's `files` array
// opts this one file back into that check; every other `*.test.ts` under
// src/server is excluded from it by design (tests aren't part of the
// published package's type surface).

it("routes/branches.ts's performMerge hook return type is exactly PerformMergeHookResult", () => {
  expectTypeOf<
    Awaited<ReturnType<NonNullable<CreateBranchesRouterOptions['performMerge']>>>
  >().toEqualTypeOf<PerformMergeHookResult>()
})

it('performBranchMerge always returns a PerformMergeHookResult (its narrowed subtype)', () => {
  expectTypeOf<PerformBranchMergeResult>().toMatchTypeOf<PerformMergeHookResult>()
})
