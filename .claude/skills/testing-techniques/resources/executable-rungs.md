# Executable rungs: what exists, and how to add one

Prose is the weakest rung by design. A shape that has cost a real defect twice is moved up
this ladder, and the move is a decision recorded in the diff — with the measurement that
justified it (how many occurrences today, what the false-positive rate would be).

## Inventory

| Instrument | Rung | Catches |
|---|---|---|
| `tools/biome-plugins/test-flake-shapes.grit` | lint (`pnpm lint`) | side effect inside `waitFor`; `afterEach` wiping `document.body`; non-ASCII in `userEvent.keyboard`/`type`; `vi.useFakeTimers` with no `useRealTimers` in the file; `.only`; un-awaited `.resolves`/`.rejects`/`toMatchFileSnapshot`/`expect.element`/`expect.poll` (plain and `.not`); a PR/issue number or `pre-fix` in a title |
| `tools/biome-plugins/logger-argument-order.grit` | lint | `log.warning('msg', x)` in `mcp-server/src/server/**` (pino drops `x`) |
| `tools/arch-lint/src/test-lazy-import-check.test.ts` | `arch-lint-node` | literal `await import()` in a test file with no mock machinery and no `lazy-import:` marker |
| `tools/arch-lint/src/test-title-check.test.ts` | `arch-lint-node` | two tests sharing one full `describe > it` path in a file |
| `tools/arch-lint/src/test-fixed-sleep-ledger.test.ts` | `arch-lint-node` | a file gaining a fixed-duration sleep (`setTimeout(r, N>0)` in a promise); per-file count pinned by equality, a ratchet |
| `apps/web/src/browser-test-name-length.test.ts` | `web-jsdom` | browser titles past the 155-char budget (`?raw` source scan, no `node:fs`) |
| `apps/web/src/App.lazy-coverage.test.ts` | `web-jsdom` | a `React.lazy` page neither mocked nor statically imported by `App.test.tsx` |
| `apps/web/src/test-config/vitest-browser-optimize-deps.test.ts` | `web-jsdom` | `optimizeDeps.include` missing a package every browser test imports |
| `apps/web/src/test-utils/no-setstate-in-render.ts` (`assertNoSetStateInRenderWarning`) | per-test assertion | React's setState-during-render warning, read from a `console.error` spy rather than eyeballed in the log |
| `packages/mcp-server/vitest-data-dir.test.ts` | `mcp-node` | the suite reaching the real `~/.whiteboard` |
| `local-node-version.test.ts`, `local-gate-command.test.ts`, `dev-rules-contract.test.ts`, `dev-rules-budget.test.ts` | `mcp-node` | wrong Node major; `check:local` drifting from CI's `check` job; rule/skill prose contradicting reality; always-on context growing unmeasured |
| `tools/checks/src/vitest-projects.mjs` (+ `ci-verify-coverage`, `docs-contract`) | `mcp-node` | a vitest project CI never runs; a project without `name:` |
| `.claude/scripts/quarantine.test.mjs`, `biome-plugin.test.mjs` | `pnpm test:scripts` | quarantine cap/age/undeclared skips; a GritQL pattern that stopped matching |
| `apps/web/vitest.setup.ts`, `src/test-utils/browser-setup.ts`, `vitest.browser.shared.ts` | setup guard | unmounted trees, leaked fake timers (fails the test by name), `localStorage`, missing stylesheet, 1000ms async budget, trace growth |
| `src/test-utils/browser-setup.ts`'s `expectLoggedFailures` | setup guard (`web-browser`) | any `console.error`/`warn` in a browser test — a failure that was caught, logged and swallowed. Strict, no allowlist; opt in per test to claim one |
| `apps/web/vitest.setup.ts`'s act guard | setup guard (`web-jsdom`) | React's act complaints — `act` inside a `waitFor`/`findBy*`, or imported from `react` rather than RTL |
| `background-work-costs.test.ts` + `loop-availability.ts` | `mcp-node` | a declared stall ceiling no test asserts |

## Adding a GritQL shape

Biome runs the plugin over `**/*.test.ts(x)` and `**/*.browser.test.ts(x)` (`biome.json`
`plugins[].includes`). What Biome's GritQL subset has been seen to support here: snippet
patterns with `$vars`, `as $name`, `where`, `<:`, `contains`, `within`, `not`, `or { }`,
`r"regex"` on a captured string, `$program` for the whole file, and
`register_diagnostic(span, message, severity)`.

1. **Measure first.** Count occurrences on the current tree (`biome lint --config-path <tmp
   dir with only the new plugin> $(git ls-files '*.test.ts' '*.test.tsx')`). Zero is the
   cheapest rule to add; many means the rule needs a narrower shape or a migration in the
   same PR. The un-awaited-assertion rule measured 0; `.only` measured 0; the
   `expect.element`/`expect.poll` pair measured 0 across 163 call sites.
2. **Prototype outside the repo**: a scratch `biome.json` whose `plugins` names the `.grit`
   by absolute path and whose linter has `recommended: false`, plus a sample file carrying the
   bad AND the good form. Check the good form stays silent — `return expect(...).resolves`
   and `await expect(...)` both had to be excluded from the un-awaited rule.
3. **Add the pattern to `test-flake-shapes.grit`** with the comment saying what fails and how
   it reads (the message is what the author sees; name the fix, not just the sin). Every
   regex group is `(?:...)`: a capturing group is a pattern VARIABLE to Biome's GritQL, and
   one errored the whole plugin — silencing every other rule — until the fixture guard
   noticed.
4. **Give every SHAPE its own message — each pattern, and each `or { }` alternative.** The
   guard compares the SET of messages, so any shape that cannot produce a message of its own
   is a shape it cannot notice losing. Both halves measured on the `expect.element`/
   `expect.poll` rules: two patterns sharing one message with the `.not` pattern broken →
   `pnpm test:scripts` **279 pass**; one pattern covering both kinds with `poll` dropped from
   the `or { }` → **279 pass** again. Adding fixture LINES closes neither; the message set is
   what the guard compares. Split into four, each fails the guard by itself, and the
   diagnostic gains the form it is naming.
5. **Extend the fixture pair** in `.claude/scripts/fixtures/biome-plugin/{bad,good}.test.tsx`.
   `.claude/scripts/biome-plugin.test.mjs` reads every `register_diagnostic` message out of the
   plugin and requires the bad fixture to reach each one and the good fixture to reach none —
   no rule count lives in a title or an assertion, so a new rule with no fixture line fails by
   itself. A pattern edit that stops matching leaves `pnpm lint` green over exactly the shapes
   it was built for; the fixture pair is what notices.
6. `pnpm test:scripts && pnpm lint`.

A shape whose textual form has too many legitimate instances stays prose: the held-reference
shape flags ~90% false positives as a scan (audit-triage 2026-08-21), so it is reader judgement
plus resolver-taking helpers instead.

## Helpers: point the failure at the call site

An assertion helper's failure leads with the helper's own `expect` line, which is never where
the problem is. `vi.defineHelper` strips the helper's frames:

```ts
export const assertLedger = vi.defineHelper(function assertLedger<K extends string>(
  what: string, ledger: Record<K, SurfaceCoverage>, tally: Record<K, number>,
): void { /* … */ })
```

Measured on a forced ledger failure — plain, the stack leads with
`❯ assertLedger src/test-utils/coverage-ledger.ts:70:9` and quotes the helper's source before
naming the caller; wrapped, it is `❯ src/zz-helper-probe.test.ts:11:3` and nothing else. The
message is identical either way; what changes is which file the reader opens first, and for a
ledger that is the test owning the surface that grew, never the shared helper.

Wrapped here: `assertLedger`, `assertScannedLedger`, `focusEditable`,
`assertNoSetStateInRenderWarning`. Wrap a helper when it ASSERTS; a helper that only builds a
fixture has no failure to relocate.

## Adding a setup-file guard

The rung for "every test in this project, at runtime". `apps/web/vitest.setup.ts`'s
`runSharedTestTeardown` is the pattern: factored out so `vitest-setup.infra.test.tsx` can
exercise it directly (throw + restore), and reporting the offending test BY NAME rather than
restoring silently. Order matters inside it — unmount first, so a file that also leaks fake
timers still gets its trees torn down.

## The swallowed failure, and why one project is guarded and the other is not

A caught-and-logged exception is the worst failure shape a suite has: the run
keeps going and breaks somewhere unrelated. The measured case — a
`@codemirror/view` ViewPlugin crash that disabled the CRDT binding for the life
of the view, surfacing ten seconds later as `expected 'untitled' to be 'Weekly
review'`, an assertion about a document NAME in a different panel.

Whether that becomes a guard or a ledger is a MEASUREMENT, not a judgement:

| project | records | over | verdict |
|---|---|---|---|
| `web-browser` | **1**, the one a test provokes on purpose | 235 files, 1237 tests | free — strict, no allowlist |
| `web-jsdom` | **82**, across 63 tests | 377 files, 3947 tests | a ledger of ~63 claims, not yet written |

`web-jsdom` started at 219. **138 were React's act-environment complaint** and
are now gone entirely (below); the remaining **82**, spread over 63 tests, are
mostly tests driving a failure path deliberately (`canvas exploded`,
`network down`, a refused tool registration). Logging is the right behaviour
there, so guarding the project on `console.error` at large still means claiming
each one — real work, worth doing on its own merits. The act family is guarded
already, because that part became free.

### Take this measurement with a RECORDER, never a throwing guard

The obvious way to size it — install the strict guard and read what turns red —
is wrong here, and wrong in both directions at once. Throwing in `afterEach`
breaks the shared teardown: React trees stay mounted, and every later test in
the file cascades. Measured, same suite, same commit:

|  | throwing guard | file recorder |
|---|---|---|
| records | ~100 | **219** |
| tests reporting | 73 | **70** |
| un-acted React updates | 878 | **0** |

It under-reported the records (each test aborts at its FIRST one) while
inventing 878 un-acted updates that do not exist — the cascade from its own
broken teardown. A throwing guard is the right SHIPPING shape and the wrong
measuring instrument.

Two traps beside it, both of which produced a confident wrong number here:

- **Vitest's terminal output carries no test console records in these runs.**
  Grepping the run's stdout for a warning returns 0 whether or not it happened.
  Every count above comes from a recorder appending to a file, with
  `expect.getState().currentTestName` for attribution.
- **A `console.error` format string is recorded raw.** The message is
  `An update to %s inside a test was not wrapped in act(...)`; grepping for the
  formatted component name finds nothing.

### The act flag, measured and rejected — and what worked instead

`IS_REACT_ACT_ENVIRONMENT` was set nowhere, so React logged
`The current testing environment is not configured to support act(...)` 138
times. Setting it in the jsdom setup looks like the obvious fix. Measured over
the full project:

| | config warning | un-acted updates | total records |
|---|---|---|---|
| flag off | 138, in 8 tests | 0 reported | 219 |
| flag on | 103 | **502** | 689 |

It fails to clear the noise it targets and triples the channel. **Rejected.**

The real causes were two, with no syntax in common, and three mechanical fixes
took all 138 to **0**:

- **`act()` wrapping an RTL async utility** (103). `@testing-library/react`
  sets the flag to FALSE around `waitFor`/`findBy*` on purpose, so an `act`
  call inside one warns — measured at the warning itself, `flag=false`. The
  wrapper is also unnecessary: those utilities manage `act` themselves. Both
  call sites wrapped a HELPER that used `findBy*` internally, which is why
  neither a reader nor a lint rule looking at one file could see it. Five
  wrappers deleted, tests unchanged and still passing.
- **`act` imported from `react`** (35). RTL's `act` sets the environment flag
  itself; React's bare one does not, so every call warns. Two files, import
  changed.

That left the guard FREE, which is the point — it is in
`apps/web/vitest.setup.ts` and fails any test React complains about, narrow to
the act family rather than `console.error` at large. Mutation-checked: putting
one wrapper back fails that test with `React complained about act() in this
test.`

Records over the whole project: **219 to 82**, over 70 tests to 63.

### What the measurement found

Neither of these was found by reading code. Both fell out of asking a suite to
stop swallowing:

- **502 un-acted React updates**, invisible until the flag is set, over 26
  distinct components — about a quarter of them Radix internals (Tooltip,
  Presence, Popper) rather than this repo's own hygiene.
- **`[document-sync] backfilling thread marks failed Index out of bound. The
  given pos is 20, but the length is 19`, in three PASSING tests.** Two
  defects, one throw. `resolveTextAnchor`'s stored-offsets shortcut compared
  `body.slice(anchor.start, anchor.end) === exact` — and `slice` CLAMPS, so on
  a body shorter than the stored `end` it returns the tail rather than
  nothing, and a stored range whose width disagrees with its own quote MATCHES
  and is answered verbatim. `markThreadPassages` then handed that `end`
  straight to `LoroText.mark`, which throws from inside the CRDT naming
  neither the thread nor the document, into a catch that logs and carries on.
  Consequence: those conversations never got their passage marks.

  Worth recording as a diagnosis, because two confident explanations came
  first and both were wrong. "It measures offsets against `readMarkdownBody`
  and applies them to the text container" does not fit the numbers — a
  non-empty container makes those the same string. "Loro indexes text by code
  point while JS counts UTF-16" was refuted by probing the installed version:
  `text.length` is 18 for a body JS also calls 18. The mechanism only came out
  by reading what produces the range, and the fixture confirms it — the anchor
  is `{ exact: 'is this still true?', start: 0, end: 20 }`, and that quote is
  19 characters.

## Adding a source-scan test

For a rule about test FILES rather than test behaviour (a title budget, an import shape, a
count in a comment that would go stale). Repo-wide scans live in `tools/arch-lint/src/` and
share `test-scan-dirs.ts` (`TEST_SCAN_DIRS`, `listTestFiles`); app-local ones stay in the
app. A scan that only STOPS growth pins today's count per file by equality and calls itself
a ratchet (`test-fixed-sleep-ledger.test.ts`). Two constraints:

- `apps/web` is browser-only, so read sources with `import.meta.glob(..., { query: '?raw' })`
  rather than `node:fs` (`web-app-boundary.test.ts` enforces the boundary).
- **Guard from both sides.** An exemption list is pinned so an entry cannot outlive what it
  names; a scan asserts it REACHED the surface (`scannedFiles > 300` in the quarantine scan,
  a floor on route count beside an allowlist walk) — a glob that matches nothing reports
  "0 problems", which is what a broken scan looks like.

## Adding a config guard

When the hazard is in a `vitest*.ts` (a timeout, a data dir, a trace bound), the guard is a
test that reads the config or its effect (`vitest-data-dir.test.ts`,
`vitest-browser-optimize-deps.test.ts`), and the measurement that sized the number lives in a
comment beside the number. A number with a source named beside it is still unbacked if
nothing reads the source — `background-work-costs.test.ts` is the worked case.
