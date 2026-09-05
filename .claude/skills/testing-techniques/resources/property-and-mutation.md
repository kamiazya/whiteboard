# Property-based and mutation testing: closing the loop

`test-layer-selection` says WHEN to write a property and the disciplines (never pin a seed,
denser generator over more runs, no oracle built from the subject). This resource is the other
half: how to know the property asserts something, and what to do with a survivor.

## The loop

```
property (fast-check)  →  mutation run (Stryker, or by hand)  →  survivor
      ↑                                                            │
      └── denser domain + reachability floor, or a coverage ledger ─┘
```

Two properties in `canvas-render` were found asserting nothing at all — a cache-hit branch no
run reached, and a predicate whose false case one draw in a billion could produce. Both pass
every gate except this loop.

## Writing the property

- Wrappers: `packages/mcp-server/src/shared/test-utils/fast-check.ts`,
  `apps/web/src/test-utils/fast-check.ts`, `packages/canvas-viewer/src/test-utils/fast-check.ts`
  — `fc`, `fcTest`, and `withDefaults()` (200 runs). Override through `withDefaults({ numRuns })`,
  not an inline object.
- Budget by layer: node projects afford the default; jsdom stays modest; browser projects keep
  it to single digits–~20 (real browser + IndexedDB per run).
- File names: `*.property.test.ts` (invariants), `*.model.test.ts(x)` (model-based state
  machines), `*.race.test.ts(x)` (ordering).
- **Assert the subject is present**, beside the property: a reachability floor
  (`expect(reached / total).toBeGreaterThan(x)` measured, not guessed), or a count. A generator
  too sparse to reach the interesting arrangement passes vacuously, and a run that reaches
  nothing reports green.
- **Surfaces that grow get a ledger** (`.claude/rules/coverage-ledger.md`, path-scoped):
  `assertLedger` in `apps/web/src/test-utils/coverage-ledger.ts` maps each member of the
  surface's own type to `covered` / `not modelled: <reason>`, so member N+1 fails the test
  that models the surface. Three conditions, all required: it grows, something models it, a
  miss would be silent.

## Reading a failure

- `... (with seed=N)` in the test NAME is printed on EVERY outcome. `Error: Test timed out`
  is a timeout, not a counterexample — check the budget and whether the code got more
  expensive (`resources/async-and-timers.md`).
- A shrunk counterexample is **never a flake**, however random it looks. Reproduce with
  `withDefaults({ seed })`, pin the shrunk input as an example test BEFORE fixing, fix, then
  mutation-check. Exclude an input only explicitly, with a comment and a ticket — never by
  pinning the seed or weakening the property. One such "flake" was silent content corruption in
  the markdown round trip, reached from a PR in another package.

## Mutation runs

| Lane | Command | Scope | Reports |
|---|---|---|---|
| contracts | `pnpm mutation:contracts` | `packages/mcp-server/stryker.config.mjs`'s twelve files: redaction, path guard, security config, api contracts, two routes | local; `check:release-candidate:local` |
| render | `pnpm mutation:render` | `packages/canvas-render/stryker-targets.mjs` — the property-covered pure modules | `mutation.yml`: on a PR, scoped by `.claude/scripts/mutation-scope.mjs` to the curated files the diff touched and posted as a sticky comment; weekly, the whole list as an artifact |

Both are **report-only** (`thresholds.break: null`): a score belongs to the whole suite, not
to whoever pushed last. Stryker's timeout is 20s because a timeout counts as KILLED and the
default 5s flattered the score on healthy-but-slow property mutants.

Each lane runs under its own `vitest.stryker.config.ts`, which excludes tests that fail under
Stryker's worker isolation (`vi.spyOn(process.stderr, 'write')`). Never use it for a normal
run; before adding an exclusion, confirm the test passes in the normal suite and record why.

## Triaging a survivor

1. **Verify by hand first.** Apply that exact edit, run the suite, watch it stay green. The
   tool can report a false survivor (`seed.ts` in canvas-render is excluded for that reason);
   a survivor that turns red by hand is the tool's finding, not the code's.
2. Classify: **real risk** (a user or contract would notice → add the example or property that
   kills it), **equivalent** (identical observable behaviour → say so in the PR body),
   **perTest-escaping** (a test covers the line but Stryker's selection missed it → focused
   manual check), **intentionally permissive** (the contract allows the range → note it).
3. **A differential oracle is blind to what it shares with its subject.** 22 survivors in one
   function under a property "nobody would doubt" — both sides called the same scoring helper.
   Ask what the reference IMPORTS: exact BigInt rationals against floating-point, rasterisation
   against interval algebra. The production helper in the test is the same code twice.
4. Do not change production parsing or guard logic on a survivor alone; confirm the risk, keep
   the change consistent with the contract, and land the regression that would have caught it.

## The by-hand mutation check

For a surface outside a Stryker lane — a schema-vs-runtime fix, a browser flow, a guard test:
revert the production fix, confirm the guard goes red (`pnpm build` for a compile-time guard,
`pnpm smoke:e2e` for a runtime one, the nearest test otherwise), restore, and check the
working tree before finishing. **Run it the way the flake ran**: a mutation check green in
isolation has not exonerated a guard whose failure needs the full project in flight
(`resources/stability-checks.md`).
