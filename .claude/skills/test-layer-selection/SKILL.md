---
name: test-layer-selection
description: How to pick the nearest test layer in the whiteboard repo (mcp-node / canvas-viewer-node / canvas-viewer-jsdom / canvas-viewer-browser / apps/web jsdom / web-browser / E2E), when to reach for a property or model-based test instead of an example, and the commands to run each. Use when writing the red test for a change, or deciding where a regression belongs.
---

# Test Layer Selection

Start with the smallest failing test at the **nearest** layer. Do not jump to broad E2E if a smaller failing test can isolate the bug.

| Layer | Use for | Command |
|---|---|---|
| `mcp-node` | pure functions, stores, routes, server behavior, persistence logic in `packages/mcp-server` | `pnpm test --project mcp-node` |
| `canvas-viewer-node` | pure parsing/serialization logic in `packages/canvas-viewer` with no DOM dependency | `pnpm test --project canvas-viewer-node` |
| `canvas-viewer-jsdom` | `packages/canvas-viewer` components/hooks when browser layout & pointer behavior are NOT the core risk | `pnpm test --project canvas-viewer-jsdom` |
| `canvas-viewer-browser` | `packages/canvas-viewer` popovers, dialogs, scroll, focus, keyboard, pointer, restore flows (real browser) | `pnpm test --project canvas-viewer-browser` |
| `apps/web` jsdom project | React components/hooks in `apps/web` when browser layout & pointer behavior are NOT the core risk | `pnpm --filter @kamiazya/whiteboard-web test` |
| `web-browser` | `apps/web` tests needing real browser APIs jsdom lacks: IndexedDB, OPFS, `window.showOpenFilePicker`. File suffix `.browser.test.tsx` | part of `pnpm test:browser` |
| E2E | real routes, server composition, websocket timing, persistence order, multi-step page flows | promote only when needed |

Notes:
- Browser suites together: `pnpm run test:browser` (`canvas-viewer-browser` + `web-browser`); `pnpm run test:browser:trace` for trace artifacts on failure (under `<package>/tmp/vitest-traces`).
- After the targeted test passes, run the broader suite covering the touched area, then `pnpm test`.
- Runtime is the source of truth: if behavior disagrees with a test, fix the test or implementation to match real behavior.
- Passing tests alone are not sufficient — manually verify the real behavior (Playwright/Chrome MCP) before locking the scenario into regression coverage.

## Property-Based / Model-Based Testing (PBT)

fast-check is already wired in via shared wrappers — `packages/mcp-server/src/shared/test-utils/fast-check.ts`
and `apps/web/src/test-utils/fast-check.ts`. Reach for a property (or model-based) test instead of,
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
