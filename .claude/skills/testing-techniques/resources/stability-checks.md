# Proving a test is stable

"It passed" is one sample. A test that gates a merge has to survive the run that flakes, and
that run is never the isolated one.

## Before pushing

1. **Five fresh processes** — what CI's `stress-changed-tests` job does to every test file a
   PR touches (`.github/workflows/ci.yml`): module state, test order and process env reset each
   time, which is closer to what a flake needs than one long in-process repeat.
   ```bash
   for i in 1 2 3 4 5; do pnpm exec vitest run <file>; done
   ```
   Vitest 4.1 ignores config-level `test.repeats` (measured, which is why the loop exists);
   Vitest 5 adds a real `--repeats=N` that repeats every test in-process and fails the test on
   any failing repetition — a DIFFERENT class (state carried between repetitions of the same
   test), so it complements the fresh-process loop rather than replacing it.
2. **Once inside the whole project it belongs to.** The costliest `web-browser` test measures
   1.5s with its file alone, 1.6s with the twelve IndexedDB-heavy page files together, and
   30–39s with all 115 browser files in flight. An isolated green proves nothing about the run
   that flakes, and neither does a mutation check that stays green in isolation.
3. **Read the exit code, not the summary.** Two shapes report every test PASSED and exit 1:
   an unhandled error in teardown (`NotFoundError: removeChild`, the raw-DOM-wipe shape) and
   `EnvironmentTeardownError` from a module still loading at teardown (the module-scope
   dynamic-import shape). And a
   smaller-than-expected total is never good news: a mis-filtered `--project`, an
   `ENAMETOOLONG` in teardown, or a disk that filled mid-run each drop tests silently.

## Reading a failing run

- **Triage the EARLIEST failure in a file first** and re-measure before believing the later
  ones. A timed-out browser test keeps typing into the next one, so one overrun fails two or
  three tests and the victim names a test that is not the problem.
- `Re-optimizing dependencies` anywhere in the log means the tree moved under the suite.
  Re-run on a quiet tree and believe only the second result.
- The symptom → verdict index is `steward`'s `reference/failure-modes.md`; the measurements
  behind each verdict are `integrator-flow.md`'s CI-flakes section.
- Before publishing a cause, a "not a regression", or a by-hand verification: the
  `diagnosis-evidence` skill — choose an observation that could REFUTE the claim.

## When it is a flake

- **A flake is only a flake once.** One `gh run rerun --failed` on a known shape; the SECOND
  occurrence is a root-cause lane, not another re-run. `node .claude/scripts/flake-watch.mjs`
  (a quiet SessionStart hook) reports any test failing in ≥2 distinct main runs in 14 days,
  from the `[project] file > suite > case` annotations vitest already emits.
- A re-run is legitimate only to confirm a base-branch failure, or when the job died before any
  test body ran. A genuine property counterexample is never re-run
  (`resources/property-and-mutation.md`).

## Quarantine is bounded

Parking a flaky test is allowed and BOUNDED — Fowler's cap, so the lot cannot become the
graveyard it always decays into unbounded:

```ts
// QUARANTINE(2026-09-01 wb:issues/version-timeline-flake): focus contention, root-cause pending
it.skip('...', () => {})
```

`.claude/scripts/quarantine.test.mjs` (`pnpm test:scripts`, in `check:local` and CI's check
job) fails past **8 parked** or **14 days** each, on a marker missing its issue or date, and
on an `it.skip` / `test.skip` / `describe.skip` carrying no marker at all. `skipIf` is not a
park — a probed premise that cannot hold here is allowed to skip and say so
(`resources/isolation-and-state.md`). The date is when parking started, judged from the
marker, not from git history a refactor rewrites.

## Never

- Never skip, disable or quarantine a test to get green without the marker and the ticket.
- Never push an empty commit to kick CI.
- Never pin a fast-check seed.
- Never raise a timeout to make a failure slower; size it on a measurement and record the
  measurement beside it.
