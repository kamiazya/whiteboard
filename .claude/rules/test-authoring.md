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
  mutation, stability checks, naming and structure, executable rungs, configuration, upgrade).

The write-time rules, so the skill is a lookup rather than a prerequisite:

1. `await` every `.resolves` / `.rejects` / `toMatchFileSnapshot` / `expect.element` / `expect.poll`.
2. No side effect inside `waitFor`; fire outside, assert inside.
3. Query inside the assertion; never hold an element across an action that can remount it.
4. Type ASCII in browser tests.
5. Restore what you change: fake timers, stubbed env, mocks, storage.
6. Assert on handles the test minted, never on a global counter or a "most recent" stream.
7. Static imports unless the file mocks what it imports (`lazy-import: <reason>` otherwise).
8. A count proves the subject is present beside every allowlist walk and every property.
9. A skip is probed, never inferred, and impossible on CI.
10. A title is an identifier: behaviour, not chronology or a count/ordinal of something that grows; unique in its `describe`.
11. Wait for a condition (`vi.waitFor`, `expect.poll`, fake timers), never for time; the sleep ledger
    only goes down, and reads `test-utils/**` and `*-contract.ts` helpers too, so a sleep in a
    shared helper is ledgered with a reason.
12. Before pushing: five fresh-process runs of the file, then one inside its whole project.
13. A threshold computed from the run divides by the dimension the fixture grows, and the
    growth loop floors that dimension — otherwise the slower machine gets the stricter test.
14. `act` comes from `@testing-library/react`, never `react`, and never wraps a `waitFor` /
    `findBy*` (RTL turns the act environment off inside those, deliberately).
15. A test that provokes a logged failure claims it — `await expectLoggedFailure('<fragment>')`
    in `web-jsdom`, which asserts the report arrived; `expectLoggedFailures()` in `web-browser`,
    which returns the records to assert on. Never an allowlist entry.

Executable rungs already hold most of these (`pnpm lint`'s GritQL plugin, `arch-lint`'s scans,
the jsdom setup's teardown). A shape that costs a real defect twice moves up the ladder —
`testing-techniques/resources/executable-rungs.md` says how, fixture pair included.
## Browser mode

- **Window state.** A test that leaves the browser WINDOW in a state the next file cannot
  tolerate (today: entering real fullscreen, which makes Chromium refuse `page.viewport` for
  the next file that resizes) is named `*.window-state.browser.test.tsx` and runs alone in
  `web-browser-window-state`. Why a project rather than a fix in the test is measured in
  `apps/web/vitest.browser-window-state.config.ts`.
- **The default trace has no DOM view** — actions, stacks and screenshots only, because
  recording the DOM records every resource vite serves: 23GB a run, filling the disk and
  reporting a test count short of the real one. Re-run the ONE failing file under
  `pnpm run test:browser:trace <file>` — it traces every test, so it refuses a run naming no file.
- **Keep a browser test's `describe` + `it` titles under its project's budget: 166 minus the
  project name's length** (155 for `web-browser`, 145 for the canvas projects, 142 for the
  window-state one), in characters, not UTF-8 bytes: vitest turns every non-alphanumeric
  character into one ASCII `-`, so `導線` costs two. vitest copies the trace into
  `.vitest/attachments/` under a name flattened from its path, and past the filesystem's
  255-byte limit that copy throws `ENAMETOOLONG` during teardown — so vitest abandons the REST
  OF THE FILE. Measured: a 194-char title reported `1 failed | 2 passed (6)`, a 58-char one
  `1 failed | 5 passed (6)` — three tests silently did not run, which reads like good news.
  `tools/arch-lint/src/browser-test-name-length.test.ts` enforces the budget.
- Timeouts are ceilings sized on a recorded measurement, never delays.
