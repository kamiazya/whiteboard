---
name: testing-techniques
description: The whiteboard repo's automated-testing technique catalogue — how to write a vitest test that stays green under a full parallel run (async assertions, fake timers, browser mode, mocks and isolation), how to prove a test is stable before pushing (repeats, stress, quarantine budget), how property-based and mutation testing close the loop on a test that asserts nothing, which flake shapes are already caught by an executable rung (GritQL plugin, setup-file guard, arch-lint scan) and how to add one, and the vitest features (including Vitest 5's: traceView, strict locators, vi.when, --repeats, expect.poll with AbortSignal, fsModuleCache, vitest doctor, the bench fixture) that serve each. Use when writing or reviewing a test, when a test flakes or times out, when a property or Stryker survivor needs triage, when configuring or running vitest, or when upgrading it. For WHICH layer a test belongs in, see test-layer-selection.
---

# Testing techniques (whiteboard)

`test-layer-selection` answers **where** a test goes. This skill answers **how to write one
that stays green** and **how to know it asserts something**. The body here is an index; the
detail is in `resources/*.md`, opened one at a time for the situation at hand — never all at
once.

## The rung ladder

Every technique here sits on a rung, and the rung is chosen by what would actually catch the
mistake — strongest first:

| Rung | Catches the mistake… | This repo's instruments |
|---|---|---|
| **executable** | at lint / typecheck / test time, mechanically | `tools/biome-plugins/test-flake-shapes.grit` (rules read from the file by its guard), `tools/arch-lint`'s test scans (lazy imports, duplicate titles, the sleep ledger), guard tests (`browser-test-name-length`, `vitest-data-dir`, `local-node-version`) |
| **setup guard** | at runtime, for every test in a project | `apps/web/vitest.setup.ts` (cleanup, fake-timer leak, localStorage), `browser-setup.ts` (stylesheet, async budget), `sharedBrowserTestConfig` (trace bounds) |
| **review criteria** | when a reviewer reads the diff | `review-gate/resources/test-coverage.md` |
| **prose** | only if someone remembers | `integrator-flow.md`'s CI-flakes section (the measurements), this skill |

A shape that costs a real defect twice earns a higher rung. How to move one up is
`resources/executable-rungs.md`.

The resources describe the INSTALLED vitest — the `vitest:` line of `pnpm-workspace.yaml`'s
catalog (5.0.0 since 2026-09-05). A config key the installed version does not know is
ignored silently, so check the version before relying on one. Features newer than a
reader's training carry their API and a snippet, beside the situation each serves — never
in a file named after a version, which only a reader who already knows the feature opens.

## Open the resource for the situation

| Situation | Resource |
|---|---|
| naming a test or a file, a duplicate title, a fixed sleep, a count or ordinal in a title | `resources/naming-and-structure.md` |
| async assertions, `expect.poll`, `waitFor`, fake timers, clocks, scheduler teardown | `resources/async-and-timers.md` |
| a `.browser.test.tsx`: focus, typing, locators, timeouts, titles, traces | `resources/browser-mode.md` |
| mocks, module state, storage, data dirs, workers, `--project` filters | `resources/isolation-and-state.md` |
| a property test, a Stryker survivor, a generator that reaches nothing, a coverage ledger | `resources/property-and-mutation.md` |
| "is this test stable?" — repeats, stress, isolation vs full run, quarantine, flake-watch | `resources/stability-checks.md` |
| adding a GritQL shape, a setup-file guard, or a source-scan test | `resources/executable-rungs.md` |
| projects and filters, pools and caches, `.vitest/` artifacts and reporters, benchmarks, custom matchers, coverage | `resources/configuration.md` |
| moving to a new vitest major: breaking changes measured against this tree, and the order to land them | `resources/vitest-upgrade.md` |

## Write-time checklist (the shapes that cost the most, in one screen)

1. **`await` every `.resolves` / `.rejects` / `toMatchFileSnapshot` / `expect.element` /
   `expect.poll`.** Lint rejects the first three; Vitest 5 fails the test.
2. **Nothing with a side effect inside `waitFor`.** A retried callback re-fires the action.
3. **Query inside the assertion**, never hold an element across an action that can remount it.
4. **Type ASCII** in browser tests; a keycode-less character is the one that drops under load.
5. **Restore what you change**: fake timers, `vi.stubEnv`, module mocks, storage. The jsdom
   setup fails the test that leaks fake timers, by name.
6. **Scope every assertion to a handle the test minted** — never a global counter or a "most
   recent" stream while another test's worker may still be alive.
7. **Static imports only** in a test file unless it mocks what it imports; an in-body
   `await import()` charges a module graph to the per-test timeout.
8. **A count proves the subject is present**: `expect(routes.length).toBeGreaterThan(N)` beside
   an allowlist walk, a reachability floor beside a property.
9. **A skip is probed, never inferred**, and must be impossible on CI.
10. **A title is an identifier**: behaviour, not chronology (no PR/issue number, no
    "pre-fix"), no count or ordinal of a registry that grows, unique within its `describe`.
11. **Wait for a condition, never for time**: `vi.waitFor` / `expect.poll` / fake timers, not
    `setTimeout(r, N)`. The per-file sleep ledger only goes down.
12. **Before pushing**: run the file 5× in fresh processes, then once inside the whole project
    — isolation proves nothing about the run that flakes.

## Commands

```bash
pnpm test --project <name>              # nearest layer (names: test-layer-selection)
pnpm test:browser                       # the three real-browser projects
pnpm test:browser:trace                 # + DOM snapshots — ONE failing file only (23GB otherwise)
for i in 1 2 3 4 5; do pnpm exec vitest run <file>; done   # what CI's stress step does
pnpm lint                               # includes the GritQL flake-shape plugin
pnpm test:scripts                       # plugin fixture guard + quarantine budget
pnpm mutation:contracts | pnpm mutation:render             # Stryker lanes
node .claude/scripts/flake-watch.mjs    # tests failing ≥2 main runs in 14 days
```
