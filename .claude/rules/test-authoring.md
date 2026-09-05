---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "**/*.bench.ts"
  - "**/vitest*.ts"
  - "tools/biome-plugins/*.grit"
---

# Test Authoring

You are in a test, a vitest config, a bench, or the lint plugin that polices them. Two skills
carry the detail, loaded on demand rather than here:

- **`test-layer-selection`** — WHICH project this belongs in, and when a property or model
  test beats an example.
- **`testing-techniques`** — HOW to write one that stays green under the full parallel run,
  how to prove it is stable, and how a property or Stryker survivor is closed. Open the one
  `resources/*.md` for your situation (async/timers, browser mode, isolation, property and
  mutation, stability checks, executable rungs, Vitest 5).

The ten write-time rules, so the skill is a lookup rather than a prerequisite:

1. `await` every `.resolves` / `.rejects` / `toMatchFileSnapshot` / `expect.element` / `expect.poll`.
2. No side effect inside `waitFor`; fire outside, assert inside.
3. Query inside the assertion; never hold an element across an action that can remount it.
4. Type ASCII in browser tests.
5. Restore what you change: fake timers, stubbed env, mocks, storage.
6. Assert on handles the test minted, never on a global counter or a "most recent" stream.
7. Static imports unless the file mocks what it imports (`lazy-import: <reason>` otherwise).
8. A count proves the subject is present beside every allowlist walk and every property.
9. A skip is probed, never inferred, and impossible on CI.
10. Before pushing: five fresh-process runs of the file, then one inside its whole project.

Executable rungs already hold six of these (`pnpm lint`'s GritQL plugin, `arch-lint`'s scans,
the jsdom setup's teardown). A shape that costs a real defect twice moves up the ladder —
`testing-techniques/resources/executable-rungs.md` says how, fixture pair included.
Browser `describe` + `it` titles stay under 155 characters combined; timeouts are ceilings
sized on a recorded measurement, never delays.
