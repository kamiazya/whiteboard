# Integrator Flow (git / CI mechanics)

Hard-won mechanics for the integrator session. Each rule exists because skipping it caused a real incident. Mechanics that could be automated live in automation instead: a PostToolUse hook syncs local main after every `gh pr merge`, a PreToolUse hook blocks `gh pr create` while the branch is behind origin/main, and `new-worktree.mjs` branches from a freshly fetched `origin/main` under the main checkout. When a hook reports "pull skipped" or blocks a PR, resolve the cause rather than working around it.

## pnpm-lock.yaml conflict recipe

When merging main into a feature branch conflicts on `pnpm-lock.yaml`:

```bash
git checkout origin/main -- pnpm-lock.yaml
pnpm install --no-frozen-lockfile   # re-adds this branch's additions
git add pnpm-lock.yaml && git commit --no-edit
pnpm install --frozen-lockfile      # must pass before pushing
```

Never hand-edit the lockfile. If typecheck breaks after a lockfile change with "two copies of the same version" type-identity errors, the branch is usually stale — merge current main first before deeper archaeology.

## Long-running watches

- Use the harness `Monitor` tool for anything that must be watched across turns (CI checks, PR states, deploys). A background subagent's polling loop dies with its turn — a subagent told to "keep polling" will silently stop.
- If an executor agent is needed, pair it with a Monitor: the monitor detects the event, the main session wakes the agent for one action.

## Verifying on a Preview deployment

`apps/web` registers a Workbox service worker with `registerType: 'prompt'`, so **what the server deploys and what the browser executes are two different questions**. A URL you have opened before keeps running the bundle from that visit, and **reloading does not change that** — under `prompt` the new worker waits until something calls `skipWaiting`.

For a real user that is handled and deliberate: a scheduler checks for updates periodically and on tab focus, and `UpdateToast` offers the swap rather than performing it under someone mid-draw. The pitfall is for anyone verifying a fix by *driving the page from a script*, which reloads without ever taking the offer.

It fakes the most misleading result there is: a fix that is deployed, correct, and covered by tests, behaving in the browser exactly as if it had never been written. Checking the deploy history does not rule it out — that answers what the server returns, not what the page runs.

Accept the update through the toast if it is showing. Otherwise clear the worker outright:

```js
// In the page console. `controlled: true` means you may be running an old bundle.
await navigator.serviceWorker.getRegistrations()
// Clear it, then reload:
for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister()
for (const k of await caches.keys()) await caches.delete(k)
```

When a preview contradicts a green test, suspect the cache before suspecting the layer under test. The cheapest discriminator is a **control action**: exercise some other feature that writes through the same path (adding a node, say). If the control persists and the feature under test does not, the transport and the server are fine and the difference is in the code the browser is actually running.

## CI flakes

- A known-flake failure gets one `gh run rerun <id> --failed`. The second occurrence of the same flake in CI promotes it to a root-cause fix lane (own worktree + dev-loop); do not keep re-running.
- **A property-test failure is not a flake, however random it looks.** fast-check reports a seed; a different seed passing means the generator did not reach the input, not that the input is fine. Re-running is how a real defect gets waved through — and how it comes back to block an unrelated PR. Reproduce by passing that seed to `withDefaults({ seed })`, read the shrunk counterexample, and then either fix it or exclude the input EXPLICITLY with a comment and a task (never by pinning the seed, and never by weakening the property). One such failure this way turned out to be silent content corruption in the markdown round trip, reached from a PR that touched a different package entirely.
- Timestamp-equality and post-teardown assertions on shared global resources (real home dir, wall clock) are the recurring flake shapes here — reviews should reject new ones.
- **A fourth and fifth shape, both found by root-causing rather than
  re-running (the two that flaked all through 2026-08-14).** Neither is a
  timer: both are a test depending on the environment being QUIET, which under
  a full parallel suite it never is.
  - **A `lazy()` dynamic import racing a `findBy*` query.** `apps/web`'s pages
    are `React.lazy` for bundle-size reasons that must not change, so in a test
    the chunk's transform-and-load is charged to the query waiting on it —
    testing-library's default retry budget is **1000ms**, far tighter than the
    per-test timeout that caught the shape above. The fix is the same in kind:
    move the load into the collection phase by `vi.mock`ing the page or
    statically importing it in the test file. `App.test.tsx` already did this
    for one page and said so in a comment that counted *"the other three"* — a
    fourth was added later, matched neither branch, and flaked for months.
    `App.lazy-coverage.test.ts` now enforces the rule by reading both files
    (`?raw`, so no `node:fs` in browser-only apps/web), because a count in a
    comment goes stale and a guard does not.
  - **A test asserting on a global counter or a "most recent" handle while
    another test's worker is still alive.** A `SharedWorker` cannot be
    terminated, so earlier tests' workers keep opening streams; anything shaped
    like `expect(streamOpens).toBe(1)` or `pushFrame` (a single variable
    holding whichever stream opened LAST) reads someone else's traffic as its
    own. Scope every assertion to a handle the test itself minted — a document
    id, and the stream id correlated from that document's own request — and the
    ordering stops mattering. Note the direction: a neighbour opening a stream
    BEFORE yours is harmless to a "most recent" handle, and only the LATER open
    breaks it, so a reproduction has to get that order right (the first attempt
    here did not, and its mutation check passed against the unfixed code).
- **A third shape: `await import()` of a heavy module INSIDE a test body.** It charges the transform-and-load of that whole module graph to the per-test timeout (10s in `mcp-node`), which is ample on an idle machine and the first thing to blow once the full suite runs every project in parallel — aggregate import time there is measured in minutes. It reads as a mysterious load-dependent failure and the message names the test, not the import. Hoist it to a static top-level `import`, where the cost lands in the collection phase that no per-test timeout bounds. A dynamic import is only necessary when the file mocks what it imports (`vi.mock` + top-level `await import` is a different, legitimate shape), so **an in-body `await import()` with no `vi.mock` in the file is the tell**.
