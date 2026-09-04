# Integrator Flow (git / CI mechanics)

Hard-won mechanics for the integrator session. Each rule exists because skipping it caused a real incident. Mechanics that could be automated live in automation instead: a PostToolUse hook syncs local main after every `gh pr merge`, PreToolUse hooks block `gh pr create` while the branch is behind origin/main and when a diff a human can see ships with no figure in the body, and `new-worktree.mjs` branches from a freshly fetched `origin/main` under the main checkout. When a hook reports "pull skipped" or blocks a PR, resolve the cause rather than working around it.

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

## Do not touch the tree while a browser suite runs

Vite's dep optimizer watches the lockfile. A `pnpm install` — even
`--frozen-lockfile`, even one that changes nothing — logs
`Re-optimizing dependencies because lockfile has changed` and rebuilds the
module graph **under the tests already running against it**.

Measured: reverting an incidental `pnpm-lock.yaml` change mid-run turned a
green `pnpm test:browser` into **13 failing files and 49 failing tests** out
of 798 — `spatial-editor`, `context-menu` (15 of 15), `VersionTimeline`,
`merge-ui`. The re-run on a quiet tree, same commit, was 798/798. The
failing file passed 15/15 in isolation immediately afterwards, which is the
cheapest discriminator when this is suspected.

It reads exactly like a real, systemic break in whatever the diff touched,
and the diff in that case could not reach `apps/web` at all. The tell is in
the run's own log, not in any failure message — grep it for
`Re-optimizing` before diagnosing a broad browser failure. Then re-run on a
quiet tree, and only believe the second result.

The same applies to `git stash` / `git checkout` of anything the suite
imports. Start the run, then leave the working tree alone.

## CI flakes

- Parking a flake is BOUNDED: `it.skip` + `// QUARANTINE(<date> <issue>): <why>` above it. `.claude/scripts/quarantine.test.mjs` fails past 8 parked or 14 days each. PR-touched test files are stressed 5x by CI's `stress-changed-tests`.

- A known-flake failure gets one `gh run rerun <id> --failed`. The second occurrence of the same flake in CI promotes it to a root-cause fix lane (own worktree + dev-loop); do not keep re-running. The second occurrence is WATCHED: `flake-watch.mjs` (a quiet SessionStart hook) reports any test failing >=2 distinct main runs in 14 days, from the annotations vitest already emits.
- **Read the property test's MESSAGE before hunting a counterexample.**
  `@fast-check/vitest` prints the seed in the test NAME, so a plain per-test
  timeout arrives looking exactly like a property failure — `... (with
  seed=-867181341)` — and sends you looking for a shrunk input that does not
  exist. `Error: Test timed out in 5000ms` means the property never failed;
  the runs did not fit the budget. That is the load-dependent family above,
  and the remedy is `numRuns` (or a budget sized on a measurement), never a
  pinned seed. Worth measuring WHY it stopped fitting: one such timeout was
  caused by a routing change that made each case 53% more expensive, so the
  test was reporting a real cost regression in the code under it, not noise.
- **A genuine property-test failure is not a flake, however random it looks.** fast-check reports a seed; a different seed passing means the generator did not reach the input, not that the input is fine. Re-running is how a real defect gets waved through — and how it comes back to block an unrelated PR. Reproduce by passing that seed to `withDefaults({ seed })`, read the shrunk counterexample, and then either fix it or exclude the input EXPLICITLY with a comment and a task (never by pinning the seed, and never by weakening the property). One such failure this way turned out to be silent content corruption in the markdown round trip, reached from a PR that touched a different package entirely.
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
- **A sixth shape: an element reference held across an action that remounts it.**
  (Deliberately NOT scan-guarded: a textual rule for "held reference crosses a
  remounting action" flags ~90% false positives — most held references never
  cross one. Reader judgement in review, plus `focusEditable`-style
  resolver-taking helpers where a site genuinely crosses a remount, is the
  standing decision — audit-triage 2026-08-21.) A query
  resolves, the page swaps, and the assertion reads a node that is no longer in the document —
  reporting the value it had when it was detached. Measured at one such failure:
  `held.isConnected=false held.value='' live.value='Fast switch'`. The typing was always fine;
  only the node being read was dead, and the message (`expected '' to be 'Fast switch'`) is
  indistinguishable from a genuine loss. Query inside the assertion, and resolve the element
  from the page that owns it — `/title/i` matched on the outgoing page too, which is how it
  bound to the wrong one. Made likelier by anything that speeds up a transition; here it
  surfaced when a dropdown became non-modal and stopped waiting out a focus trap.
- **An eighth, and the one that multiplies the others: a timed-out browser test
  keeps typing.** Vitest abandons the test at `testTimeout`, but the
  `userEvent.keyboard` it was awaiting is a real key-event stream into a real
  browser and nothing cancels it — so the NEXT test in the file receives the
  leftover keystrokes interleaved with its own. Measured:
  `'nadn dm oarne  atpyppeinndged line'`, one test's `and an appended line`
  shuffled into the previous test's `and more typing`. The victim reads as lost
  input, names a test that is not the problem, and hides the one that is. One
  overrun therefore fails two or three tests, so **triage the EARLIEST failure
  in a file first and re-measure before believing the later ones are real.**
  `web-browser`'s budget is 60s for exactly this reason: the overrun is not
  merely a slow test, it is a corrupter.
  - Its companion, from the same run: **type ASCII.** A character with no
    keycode (an em dash) is synthesized separately from the plain keystrokes
    around it and is the one that goes missing under load — observed as
    `'# Hello from an agent  edited here'`, both spaces present and the dash
    gone, indistinguishable from an edit that never reached the backend.
- **Whether the whole browser PROJECT is in flight is itself a variable, and
  the only one that mattered here.** The costliest `web-browser` test measured
  1.5s with its file alone, 1.6s with the twelve IndexedDB-heavy page files
  together, and 30–39s with all 115 browser files running — so an isolated
  green proves nothing about the run that flakes, and a mutation check that
  stays green in isolation has not exonerated the guard it removed (one did,
  against a comment claiming the test would fail *every* run without it).
  Two obvious causes were refuted by measurement rather than argument: cutting
  `--maxWorkers` to 4 made it WORSE (33–39s, 40% more wall clock), and the
  shared-IndexedDB theory died on the twelve-file run.
- **A ninth: a test's own teardown wiping the DOM out from under React.**
  `afterEach(() => { document.body.innerHTML = '' })` leaves React roots
  mounted on detached nodes; the NEXT render's reconciler then throws
  unhandled `NotFoundError: removeChild ... not a child` — and vitest
  reports every test in the file as PASSED while the file exits 1
  ("Unhandled Errors"). Measured on CI: `Tests 3 passed (3)`, `Errors 4
  errors`, job red. Always unmount through testing-library's `cleanup()`;
  a raw DOM wipe also races the shared setup's own cleanup, so in
  isolation it reproduces only intermittently (1 in 17 reruns) while CI
  load makes it reliable.
- **A tenth: `EnvironmentTeardownError: Cannot load '<module>' ... after the
  environment was torn down`.** The ninth's signature — `2130 passed`,
  `Errors 2`, job red, so the exit code is the only tell — with another
  cause. NOT the in-body `await import()` shape: every import in the chain
  was static, so hoisting fixes nothing. Vitest instantiates a static graph
  on demand and its tail was still loading at teardown; the file it names is
  a victim. Did not reproduce in three runs of CI's own shard command.
- **A seventh: clicking a trigger whose menu is still dismissing.** The click is consumed and
  the menu stays shut, so the failure reads as "the list does not contain this item" when no
  list was ever opened — and raising the query's timeout only buys a slower identical failure.
  Measured: `menus=0 expanded=false connected=true`. Wait for `[role="menu"]` to be gone before
  re-opening.
