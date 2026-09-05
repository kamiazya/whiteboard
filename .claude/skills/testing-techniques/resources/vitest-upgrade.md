# Upgrading vitest (runbook)

Only what is specific to MOVING versions lives here. What each feature does, with its API,
lives beside the situation it serves in the other resources — a reader who does not know a
feature exists never opens a file named after a version.

Current: **5.0.0** (`pnpm-workspace.yaml` catalog; `vitest`, `@vitest/browser-playwright`,
`@vitest/coverage-v8`, and `apps/web`'s `@vitest/web-worker` move together). Requires
Vite ≥ 6.4 and Node ≥ 22.12; the catalog holds Vite 8.2 and `.node-version` pins 24.

## Procedure, in the order that worked

1. **Check the release-age window first.** `minimumReleaseAge` (7 days, strict) refuses a
   release younger than that, transitive packages included. A feature upgrade inside the
   window needs the package AND its scope (`vitest`, `"@vitest/*"`) in
   `minimumReleaseAgeExclude` with a comment saying it is a deliberate exception rather
   than the security patch the list is documented for, plus the date it can be pruned. The
   registry's SLSA provenance attestation (`npm view <pkg>@<v> dist.attestations`) is the
   due diligence that stands in for the window.
2. **Bump the catalog and `pnpm install --no-frozen-lockfile`**; read `pnpm peers check`.
   A peer that declares only the old major (`@fast-check/vitest` 0.4.1 declares `^4.1.0`)
   is a warning to test through, not a blocker — its property tests ran green on 5.0.0.
3. **`pnpm -r typecheck`** finds the removed APIs the migration guide names; grep for the
   rest (`sequential`, `VITEST_POOL_ID`, `extends: true`, removed entrypoints,
   `toHaveTextContent(/`, `-t ` in scripts). Record hits and fixes in this file.
4. **Run the non-browser projects first** (`vitest run --project=<each non-browser name>`,
   derived from `tools/checks/src/vitest-projects.mjs`), then the browser projects. Triage
   a red file by the failure-modes index before blaming the upgrade — on this move, four
   `web-jsdom` files failed on `expected undefined to be 'blob:stubbed'`, which is the
   wrong-Node-major shape `local-node-version.test.ts` names, not the upgrade.
5. **Re-measure what a number pinned**: the browser title budget's forced-failure recipe,
   the trace size baseline, any timeout sized on a measurement.
6. Rewrite the resources to the shipped state and delete any version tags.

## What the 4 → 5 move changed on this tree (2026-09-05)

| Change | Hits | Done |
|---|---|---|
| module-scope `bench` import removed; bench mode runs a `<project> (bench)` sibling | 3 files; `pnpm bench` filtered on the bare name | rewritten to the context fixture with `{ timeout: 0 }` and `bench.compare`; `pnpm bench` filters on `"canvas-render-node (bench)"`; getter warning suppressed with the reason (`configuration.md` › Benchmarks) |
| `toHaveTextContent(RegExp)` exact-only | 2 (`CommentsPanel.browser.test.tsx`) | `toMatchTextContent` |
| locators strict by default (`exact ??= true` at runtime); `toHaveTextContent` exact | ~1389 `getBy*` sites | all three browser projects re-run on Node 24: ONE failure in 1085 browser tests, a `toHaveTextContent('2')` on an element reading `2 messages` — made exact (`'2 messages'`, which is what the test's own comment says it checks) |
| un-awaited `.resolves` / `.rejects` / `toMatchFileSnapshot` fail | 0 (lint rule) | — |
| `expect.poll` rejects on timeout | 14 sites | green |
| `clearMocks` default `true` | — | green without pre-adoption |
| artifacts under `.vitest/` (repo root, for every project) | `.gitignore`, AGENTS.md, the title-budget guard's header | `.vitest-attachments/` → `.vitest/`; the attachment name shape re-measured, budget unchanged (`configuration.md` › Artifacts) |
| `--repeats` | CI `stress-changed-tests` | a `--repeats=3` pass added beside the five fresh-process runs |
| `sequential`, worker ids, `Assertion<R, T>`, inline projects, `browser.api`, removed entrypoints, `-t` chain, `toThrow('')` | 0 | — |
| nested `projects` | — | **still not adopted**: `vitest-projects.mjs` regex-scans the root config |
