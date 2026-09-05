# Async assertions, timers and clocks

Every shape here fails in the same misleading way: the test reports on something other than
what it was written to check, and the message names the wrong thing.

## Await every async assertion

`.resolves`, `.rejects`, `toMatchFileSnapshot`, `expect.element(...)`, `expect.poll(...)` each
return a promise. Un-awaited, the test finishes first; a rejection then lands as an unhandled
error attributed to whatever test is running by then, or nowhere.

- **The runner fails the test** (since Vitest 5; before it, the promise was awaited at the
  end of the test and only warned about).
- `tools/biome-plugins/test-flake-shapes.grit` rejects an un-awaited `.resolves` / `.rejects`
  / `toMatchFileSnapshot` at lint time, so the verdict lands before any runtime — including in
  a file the runtime never reaches. A `return expect(...)` is accepted: the runner awaits a
  returned promise.
- `expect.element` and `expect.poll` are not in the lint rule because their un-awaited form
  is structurally identical to the awaited one at the call site; the repo's convention is
  `await expect.element(...)` everywhere, and the runtime check is the rung for it.

## `expect.poll` and `waitFor`

- `expect.poll(fn, { timeout, interval })` re-runs `fn` until the matcher passes; always
  `await` it.

### `expect.poll` fails on timeout and hands the callback an `AbortSignal`

```ts
await expect.poll(async ({ signal }) => {
  const response = await fetch('/api/status', { signal })
  return response.status
}, { timeout: 1000, interval: 50 }).toBe(200)
```

A callback that has not settled inside `timeout` rejects the assertion instead of passing
late (Vitest 4 let a late resolution pass), and the `signal` aborts the in-flight attempt so
abandoned polls do not pile up behind the next test.
- **No side effect inside `waitFor`.** A retried callback re-fires `fireEvent` / `userEvent`
  / `render`, so the action double-fires under load and the failure blames the assertion.
  Fire outside, assert inside. Lint rejects it (the `waitFor` side-effect rule).
- Testing Library's `findBy*` / `waitFor` budget is 1000ms by default — a fast-machine number
  and far tighter than any per-test timeout. `apps/web`'s browser setup raises it to 5s
  (`configure({ asyncUtilTimeout })` in `src/test-utils/browser-setup.ts`); ten tests had
  worked around it locally before that, which is the smell of a default set too low.
- A `React.lazy` page racing a `findBy*` charges the chunk's transform-and-load to that
  1000ms. `vi.mock` the page or import it statically in the test file;
  `App.lazy-coverage.test.ts` enforces it for `apps/web`'s pages because a count in a comment
  went stale once already.

## Fake timers

- **Restore them.** A leaked fake clock runs into whatever the suite executes next and the
  next failure names the wrong test. Two rungs: the GritQL rule rejects a file with
  `vi.useFakeTimers()` and no `vi.useRealTimers()`; `apps/web/vitest.setup.ts`'s shared
  `afterEach` restores AND throws, naming the leaking test — restoring silently would hide
  the leak from whoever runs next.
- Fake timers also mock the `Temporal` API (via `@sinonjs/fake-timers` 15.4), and
  `vi.setSystemTime` reaches `Temporal.Now` even without fake timers. Nothing in this repo
  reads `Temporal` today; if something starts to, `fakeTimers.toNotFake: ['Temporal']` is
  the opt-out.
- Prefer an injected `now()` over faking the global clock for anything with TTL / revocation
  semantics — that is what lets the state machine be modelled as an `fc.commands` sequence
  with `advance-clock` as one of the operations (`test-layer-selection`).

## Clocks and timestamps in assertions

- **Timestamp equality on a shared resource is a standing flake shape** (a real home dir, the
  wall clock, a "most recent" file). Assert ordering or a range, or inject the clock.
- **A timeout in a property test is not a property failure.** `@fast-check/vitest` prints the
  seed in the test NAME either way; `Error: Test timed out in 5000ms` means the runs did not
  fit the budget, and the remedy is `numRuns` or a budget sized on a measurement — never a
  pinned seed. Worth measuring WHY it stopped fitting: one such timeout was a routing change
  making each case 53% more expensive.

## Scheduler teardown (jsdom)

React's scheduler can fire deferred work after jsdom's `window` is gone. `apps/web`'s jsdom
project drains macrotasks in its shared `afterEach` (`src/test-utils/scheduler-drain.ts`) and
`vitest.config.ts` filters exactly one post-teardown `ReferenceError: window is not defined`
from `react-dom` / `scheduler` frames via `onUnhandledError`. Deliberately that narrow: a
genuine unhandled error still fails the run.

## Timeouts are ceilings, not delays

A per-test timeout costs nothing while tests pass; it decides only how long a genuinely hung
test takes to report. Each project's is sized on a measurement recorded beside it — `mcp-node`
10s, `canvas-render-node` 20s, `web-browser` 60s — and the rule is the same for all: re-measure
before changing, and never tighten toward p99, because the max is one test rather than an
outlier family. Under a full parallel run the same test can cost 20× its isolated time
(`resources/stability-checks.md`).
