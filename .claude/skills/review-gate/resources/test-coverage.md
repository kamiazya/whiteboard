# Test coverage

Passing tests alone are not sufficient if the diff's real risk was never
exercised. Coverage here means "the nearest-layer test that would fail if
this change were reverted," not raw line count.

## Criteria

### 1. New public functions have tests

Check:
- Does every new exported function/route/tool handler in this diff have a
  corresponding test at the nearest appropriate layer (`mcp-node` /
  `mcp-jsdom` / `mcp-browser` / `web-browser` / E2E per
  `test-layer-selection`)?

### 2. Mutation-check evidence where AGENTS.md requires it

Check:
- For a schema/runtime-drift fix, is there evidence (in the commit message
  or PR body) that the fix was mutation-checked — revert the production fix,
  confirm the guard fails, restore?

### 3. No test files silently omitted from the diff

Check:
- Does the diff's description or commit message claim "tests added" while
  the actual file list shows no new/modified `*.test.*` file?

### 4. Manual verification preserved as automation

Check:
- If AGENTS.md's manual-verification step applies (UI/browser behavior),
  was the verified scenario locked into `mcp-browser` or E2E coverage, not
  left as manual-only?

### 5. Regression test for the actual root cause

Check:
- If this diff is a bug fix, does the added test fail against the
  pre-fix code (i.e. it targets the root cause), rather than merely
  asserting the new code's happy path?

### 6. No write-time flake shape in a new or changed test

Check:
- Does a new or changed test hold an element across an action that can
  remount it, assert on a global counter or "most recent" handle, wait on a
  side effect inside `waitFor`, or leave a timer/env/mock un-restored? The
  lint plugin catches six shapes mechanically; this criterion is for the ones
  it cannot see (`testing-techniques/resources/*.md` names each with its
  measured cost).
- Does a new property or allowlist walk assert the subject is PRESENT (a
  reachability floor, a count), not merely that what is present passes?
- Is every new or changed title a stable identifier — the behaviour, with no
  PR/issue number, no "pre-fix", and no count or ordinal of a registry that
  grows (lint catches the chronology; the count is reader judgement)?
- Does a new wait wait on a condition (`vi.waitFor`, `expect.poll`, fake
  timers) rather than on time (`setTimeout(r, N)`)?
