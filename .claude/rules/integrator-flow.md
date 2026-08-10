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
- Timestamp-equality and post-teardown assertions on shared global resources (real home dir, wall clock) are the recurring flake shapes here — reviews should reject new ones.
