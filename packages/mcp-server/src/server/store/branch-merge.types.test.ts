import { expectTypeOf, it } from 'vitest'
import type { CreateBranchesRouterOptions } from '../routes/branches.js'
import type { PerformBranchMergeResult, PerformMergeHookResult } from './branch-merge.js'

// Compile-time only: routes/branches.ts's pluggable performMerge hook used
// to duplicate this shape by hand as a second, independently-maintained
// interface — the two had already drifted (required vs optional counts,
// MergeBadge[] vs Array<Record<string, unknown>>) before anyone noticed.
// branches.ts now imports PerformMergeHookResult instead of re-declaring
// it, so this test fails to compile the moment the two diverge again.
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
