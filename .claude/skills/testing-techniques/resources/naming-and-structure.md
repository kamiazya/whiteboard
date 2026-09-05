# Test names and file structure

Everything here was measured on the 1261 test files of 2026-09-05. The counts are the
argument; when a count moves, the argument may too.

## A title is an identifier

CI annotations carry `[project] file > suite > case`, `flake-watch.mjs` clusters failures by
it, `-t` filters on it, and Vitest 5's `testNamePattern` matches the whole `suite > test`
chain. A title that changes when something ELSE changes loses all of that history and every
filter keyed on it. So a title describes the behaviour under test in words that stay true
while the inventory around it moves.

What makes a title unstable, with what was found:

- **A count of a surface that grows.** `'trips ALL FIVE rules'` had to become `SIX` the day a
  rule was added — and the assertion under it was a hand-maintained list of the same five.
  Counts of a FIXTURE (`'exactly one edge'`, `'two presses inside a single tick'`) are the
  test's own data and are fine; counts of a REGISTRY (rules, tools, renderers, routes) are
  not. 72 titles carry `all/every/exactly N`; nearly all are fixture counts. Where a registry
  count was in the title, the fix was the same both times: the body reads the inventory from
  its source (`biome-plugin.test.mjs` parses every `register_diagnostic` message out of the
  plugin) and the title says what the ledger proves, not how long it is.
- **An ordinal from an implementation's order.** `'(third candidate)'` names the position of
  a resolver step, which the next inserted step renumbers. Name the step (`via its index.ts`).
  Ordinals as fixture data (`'the second press'`) are fine. The same failure lives in prose:
  `integrator-flow.md` numbers its flake shapes and already lists "a third" after "a fourth
  and fifth" — refer to a shape by what it does, never by its number.
- **Chronology.** `'(CodeRabbit #953)'`, `'PR #243'`, `'the pre-fix hardcoded #333333'` —
  AGENTS.md's Source Comment Discipline, applied to titles: a review or a PR is process
  context that belongs in the commit message. Lint now rejects `PR/issue/CodeRabbit/CodeQL/
  Dependabot #N` and `pre-fix` in a title (3 found, all retitled). `'no longer offers
  rename'` and `'the retired canvas: scheme'` are NOT this: they pin a deletion, and the old
  state is what the test is about.
- **A value that is data, not chronology,** stays: `'serves the 2026-07-28 revision'` is an
  MCP protocol version; `'(4.5:1)'` is the WCAG floor.

Interpolated titles (`` it(`${path} contains no console.* call`) ``, 28 found) are fine when
the interpolation is a stable list — a file path, a member of a union. Interpolating an id,
a timestamp, or a random draw mints a new name every run; none were found.

## Duplicates

Two tests with the same full `describe > it` path in one file are one name for two
failures. The scan (`tools/arch-lint/src/test-title-check.test.ts`) keys on the full path,
so the same bare title under two describes is distinct and correct — `daemon-api-client`
says "rejects a malformed response body" once per endpoint. Measured: 2, both an identical
copy-paste of the test above them, deleted.

## One file per concern

`BrowserDocumentPage.dialog-outlives-document.test.tsx`, `App.lazy-coverage.test.ts`,
`document-store.workspace.test.ts`: a dotted suffix names the concern, and the file stays
small enough that `stress-changed-tests` re-running it five times costs little, a
timed-out browser test's leftover keystrokes reach few neighbours, and the earliest failure
in a file is easy to find. 15 files exceed 1200 lines (the largest 2593); when one of them
grows again, split by concern rather than adding a `describe`.

Describe nesting stays shallow (none at four levels), and Biome's `noExportsInTest` keeps
helpers out of test files' exports — the fixtures under `.claude/scripts/fixtures` carry a
`biome-ignore` for it because they are never executed.

## A wait is for a condition, never for time

`await new Promise((r) => setTimeout(r, N))` is wrong in both directions: too short under a
saturated run, and pure cost on an idle one. The repo has the condition-shaped tools —
`vi.waitFor` (428 uses), `waitFor` (824), `expect.poll` (14) — and fake timers with
`advanceTimersByTime` for code that itself waits on a timer. 117 fixed sleeps in 60 files
remain; `tools/arch-lint/src/test-fixed-sleep-ledger.test.ts` pins each file's count by
equality, so a file that gains one fails naming itself and a file that loses one asks for
its entry to be lowered. `setTimeout(r, 0)` yields a macrotask and is not this shape.

## Determinism

- `Math.random()` in a fixture (2 sites) makes a failure non-reproducible; `mkdtemp` for a
  unique path, a seeded generator or fast-check for random content.
- `Date.now()` (87 sites) is usually fine as an injected clock's value, and a flake shape as
  an equality operand — assert ordering or a range, or inject the clock
  (`resources/async-and-timers.md`).

## Coupling to the implementation

- `toHaveBeenCalledTimes(N)` (316 uses) pins a call count that a harmless refactor moves.
  Keep it where the count IS the behaviour (a debounce coalescing three changes into one
  commit, one DELETE for two presses); prefer asserting the effect elsewhere.
- A test whose only check is a `getBy*` / `findBy*` throw asserts by side effect. It works,
  and it reads as an assertion-free body to every scan — say what is expected
  (`toBeInTheDocument`, `toHaveTextContent`) so the failure names the expectation.
- Compound titles with `and` (1421) are not wrong by themselves; a title that joins two
  behaviours the test could fail on separately is two tests.
