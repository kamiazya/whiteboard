# Executable rungs: what exists, and how to add one

Prose is the weakest rung by design. A shape that has cost a real defect twice is moved up
this ladder, and the move is a decision recorded in the diff — with the measurement that
justified it (how many occurrences today, what the false-positive rate would be).

## Inventory

| Instrument | Rung | Catches |
|---|---|---|
| `tools/biome-plugins/test-flake-shapes.grit` | lint (`pnpm lint`) | side effect inside `waitFor`; `afterEach` wiping `document.body`; non-ASCII in `userEvent.keyboard`/`type`; `vi.useFakeTimers` with no `useRealTimers` in the file; `.only`; un-awaited `.resolves`/`.rejects`/`toMatchFileSnapshot`; a PR/issue number or `pre-fix` in a title |
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
   same PR. The un-awaited-assertion rule measured 0; `.only` measured 0.
2. **Prototype outside the repo**: a scratch `biome.json` whose `plugins` names the `.grit`
   by absolute path and whose linter has `recommended: false`, plus a sample file carrying the
   bad AND the good form. Check the good form stays silent — `return expect(...).resolves`
   and `await expect(...)` both had to be excluded from the un-awaited rule.
3. **Add the pattern to `test-flake-shapes.grit`** with the comment saying what fails and how
   it reads (the message is what the author sees; name the fix, not just the sin). Every
   regex group is `(?:...)`: a capturing group is a pattern VARIABLE to Biome's GritQL, and
   one errored the whole plugin — silencing every other rule — until the fixture guard
   noticed.
4. **Extend the fixture pair** in `.claude/scripts/fixtures/biome-plugin/{bad,good}.test.tsx`.
   `.claude/scripts/biome-plugin.test.mjs` reads every `register_diagnostic` message out of the
   plugin and requires the bad fixture to reach each one and the good fixture to reach none —
   no rule count lives in a title or an assertion, so a new rule with no fixture line fails by
   itself. A pattern edit that stops matching leaves `pnpm lint` green over exactly the shapes
   it was built for; the fixture pair is what notices.
5. `pnpm test:scripts && pnpm lint`.

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
