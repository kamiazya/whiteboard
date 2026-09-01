---
name: test-layer-selection
description: How to pick the nearest test layer in the whiteboard repo (mcp-node / canvas-viewer-node / canvas-viewer-jsdom / canvas-viewer-browser / web-jsdom / web-browser / E2E), when to reach for a property or model-based test instead of an example, and the commands to run each. Use when writing the red test for a change, or deciding where a regression belongs.
---

# Test Layer Selection

Start with the smallest failing test at the **nearest** layer. Do not jump to broad E2E if a smaller failing test can isolate the bug.

| Layer | Use for | Command |
|---|---|---|
| `mcp-node` | pure functions, stores, routes, server behavior, persistence logic in `packages/mcp-server` | `pnpm test --project mcp-node` |
| `canvas-viewer-node` | pure parsing/serialization logic in `packages/canvas-viewer` with no DOM dependency | `pnpm test --project canvas-viewer-node` |
| `canvas-viewer-jsdom` | `packages/canvas-viewer` components/hooks when browser layout & pointer behavior are NOT the core risk | `pnpm test --project canvas-viewer-jsdom` |
| `canvas-viewer-browser` | `packages/canvas-viewer` popovers, dialogs, scroll, focus, keyboard, pointer, restore flows (real browser) | `pnpm test --project canvas-viewer-browser` |
| `web-jsdom` | React components/hooks in `apps/web` when browser layout & pointer behavior are NOT the core risk | `pnpm test:web-jsdom` (jsdom project only) or `pnpm --filter @kamiazya/whiteboard-web test` (what CI runs: jsdom + `web-node`) |
| `web-browser` | `apps/web` tests needing real browser APIs jsdom lacks: IndexedDB, OPFS, `window.showOpenFilePicker`. File suffix `.browser.test.tsx` | part of `pnpm test:browser` |
| E2E | real routes, server composition, websocket timing, persistence order, multi-step page flows | promote only when needed |

Notes:
- Browser suites together: `pnpm run test:browser` (`canvas-viewer-browser` + `web-browser`); `pnpm run test:browser:trace` for trace artifacts on failure (under `<package>/tmp/vitest-traces`).
- After the targeted test passes, run the broader suite covering the touched area, then `pnpm test`.
- Runtime is the source of truth: if behavior disagrees with a test, fix the test or implementation to match real behavior.
- Passing tests alone are not sufficient — manually verify the real behavior (Playwright/Chrome MCP) before locking the scenario into regression coverage.

## Property-Based / Model-Based Testing (PBT)

fast-check is already wired in via shared wrappers — `packages/mcp-server/src/shared/test-utils/fast-check.ts`,
`apps/web/src/test-utils/fast-check.ts`, and `packages/canvas-viewer/src/test-utils/fast-check.ts`. Reach for
a property (or model-based) test instead of,
or in addition to, an example test when the change is one of:

- **Parser / serializer**: assert a round-trip (`parse(serialize(x))` equals `x`, or an explicitly
  computed normalization of `x` when the serializer is not injective) plus a totality property
  (parse either throws or returns a schema-valid value — no silent coercion).
- **State machine with time/TTL/revocation** (auth/session/challenge stores, sliding-window caches):
  model the entity as `fc.commands`-style random sequences of operations (mint/enroll/verify/revoke/
  advance-clock) driven by an injected `now()`, and assert invariants hold after every step — this
  catches ordering bugs an example test's fixed script cannot.
- **Concurrent store**: N concurrent writers converge to one agreed result (e.g. two tabs racing to
  create the same keypair land on the same key).
- **CRDT / mergeable structure**: idempotence (merge twice = merge once), commutativity/convergence
  (independent edits merged either order reach the same state).
- **Rounding / normalization**: the transform's algebraic invariant (e.g. `normalize(normalize(x)) ===
  normalize(x)`).

Prefer example/browser tests for UI wiring and one-off integrations with no clean invariant to state.

**Runtime budget by layer**: node-layer properties (`mcp-node`, `canvas-viewer-node`) can afford the
library's default `numRuns`; jsdom-layer properties should stay modest; `web-browser`/`canvas-viewer-browser`
properties are the most expensive per run (real browser + IndexedDB/etc.) — keep `numRuns` small
(single digits to ~20) and prefer the shared wrapper's `withDefaults()`-style override over inlining
`{ numRuns }` ad hoc.

**Discipline** (matches the fast-check wrappers already in the repo):
- Never pin a fast-check seed to force a flaky property green — a flake under load is a resource
  signal (lower `numRuns`), not an RNG problem to hide.
- When a property finds a real bug: pin the shrunk counterexample as an example test **before**
  fixing production code, fix the implementation, then mutation-check (revert the fix, confirm the
  pinned example — and ideally the property — goes red, then restore).
- Shared arbitraries belong in the owning package's `test-utils`, not copy-pasted per test file.
- A generator too sparse to reach the interesting arrangements — boxes that rarely overlap,
  sequences that rarely collide — passes **vacuously**. The mutation check is what catches a
  property that asserts nothing, and the fix is a denser domain plus a reachability guard with a
  measured floor, never more runs.

**A differential oracle is blind to whatever it SHARES with its subject**, and this reads as the
strongest kind of property rather than the weakest. `edge-crossing-sweep`'s oracle is the full
O(E^2) scan its sweep claims exact equality with — but both sides called the same scoring helper,
so a mutation inside that helper changed the oracle and the subject together and the property
stayed green: 22 survivors in one function, under a property nobody would have doubted.

So when you write an A-vs-B property, ask what B **imports**, not what it asserts. A reference
solved with different machinery — exact BigInt rationals against the subject's floating-point
cross-multiplication, cell-by-cell rasterisation against its interval algebra — is what makes the
comparison mean anything. Calling the production helper from the test is the same code twice.

**A test whose PREMISE this environment cannot establish SKIPS, and says so — probed, never
inferred.** Three EACCES tests need a file they cannot read, and `chmod 000` does not achieve that
for root (nor on Windows, where the mode barely means anything): the code under test never
receives the error it exists to handle, and the failure reads as a broken error path
(`expected undefined to be an instance of Error` says nothing about uid).

`CAN_DENY_FILE_READ` in `shared/test-utils` writes a file, closes it off and tries to read it,
rather than asking `getuid() === 0` — which is a guess about a mechanism that capabilities, a
read-only mount, a user namespace and Windows each decide independently. Guarded from both sides,
because **a skipped test reads exactly like a passing one**: the probe is checked against a fresh
mode-000 read, and on CI it MUST be true, so the skip cannot quietly disable those paths for
everyone while every summary line stays green.

**A guard that never reaches its subject passes, and reads exactly like a guard that checked.**
The third sibling of the two above, and the one no mutation check finds: here the assertion is
right and the subject is simply absent from the fixture, so there is nothing for it to find.
Mutating the production side is green either way when the fixture never exercises that rule.

Three instances in one session, each costing a real defect:

- `route-scope-registry.test.ts` walked apps built WITHOUT `ServerDeps`, and `/api/v1` mounts
  only when they are supplied — so nine routes were exempt from a registry-wide guard by
  accident, every `/api/v1/*` path resolving to `null`, which server mode answers 500 to.
- Nothing migrated the data dir before `http-server.ts` handed its ports a handle, so `/api/v1`
  had answered `no such table: workspaces` on a fresh dir since the day it was mounted. No test
  saw it, because every one of them migrated through some legacy call first.
- A route test's own helper pre-created the workspace, so `createWorkspace: true` was pinned by
  nothing — removing it left every case green, on behaviour a PR body claimed to preserve.

So assert the subject is PRESENT, not merely that what is present passes:
`expect(routes.some((r) => r.path.startsWith('/api/v1/'))).toBe(true)` beside the walk,
`expect(edges.length).toBeGreaterThan(20)` beside the allowlist. A count far below what the real
surface holds is evidence the fixture missed, never good news.

**Coverage ledgers**, for a property modelling a surface that keeps growing (an editor's command
set, its gesture events, its keyboard catalog, its verbs), are
`.claude/rules/coverage-ledger.md` — path-scoped to `apps/web/**` and `packages/*/src/**`, so it
loads itself when you are in those files. Worked examples: `editor-state.property.test.ts` (three
union ledgers), `editor-verbs.property.test.ts` (one), `editor-state-surface.test.ts` (the source
scan).
