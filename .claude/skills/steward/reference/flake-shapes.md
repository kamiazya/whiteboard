# Flake shapes

The measured taxonomy behind `.claude/rules/integrator-flow.md`'s CI-flakes rules
(a known flake gets one re-run, its second occurrence a root-cause lane, a
parked one is bounded). It lives here and not in the rule because it is read
when a failure needs recognising, not by every session. `reference/failure-modes.md`
is the symptom index into it.

Each shape has a stable NAME — its `###` heading — and a code comment cites a
shape by that name, never by an ordinal: the order here is not the order they
were found in, and a new shape is appended wherever it reads best.
`comment-file-pointers.test.ts` holds both halves, that a cited name resolves
and that no comment sends a reader to the rule file for a shape that moved.

## CI flakes

### property-timeout-reads-as-failure

**Read the property test's MESSAGE before hunting a counterexample.**
`@fast-check/vitest` prints the seed in the test NAME, so a plain per-test
timeout arrives looking exactly like a property failure — `... (with
seed=-867181341)` — and sends you looking for a shrunk input that does not
exist. `Error: Test timed out in 5000ms` means the property never failed;
the runs did not fit the budget. That is a load-dependent budget, like
`in-body-dynamic-import`, and the remedy is `numRuns` (or a budget sized on a
measurement), never a pinned seed. Worth measuring WHY it stopped fitting: one
such timeout was caused by a routing change that made each case 53% more
expensive, so the test was reporting a real cost regression in the code under
it, not noise.

### genuine-property-failure

**A genuine property-test failure is not a flake, however random it looks.** fast-check reports a seed; a different seed passing means the generator did not reach the input, not that the input is fine. Re-running is how a real defect gets waved through — and how it comes back to block an unrelated PR. Reproduce by passing that seed to `withDefaults({ seed })`, read the shrunk counterexample, and then either fix it or exclude the input EXPLICITLY with a comment and a task (never by pinning the seed, and never by weakening the property). One such failure this way turned out to be silent content corruption in the markdown round trip, reached from a PR that touched a different package entirely.

### shared-global-assertions

Timestamp-equality and post-teardown assertions on shared global resources (real home dir, wall clock) are the recurring flake shapes here — reviews should reject new ones.

Two shapes were found by root-causing rather than re-running (the two that
flaked all through 2026-08-14). Neither is a timer: both are a test depending
on the environment being QUIET, which under a full parallel suite it never is.

### lazy-import-race

**A `lazy()` dynamic import racing a `findBy*` query.** `apps/web`'s pages
are `React.lazy` for bundle-size reasons that must not change, so in a test
the chunk's transform-and-load is charged to the query waiting on it —
testing-library's default retry budget is **1000ms**, far tighter than the
per-test timeout that caught `property-timeout-reads-as-failure`. The fix is
the same in kind: move the load into the collection phase by `vi.mock`ing the
page or statically importing it in the test file. `App.test.tsx` already did
this for one page and said so in a comment that counted *"the other three"* — a
fourth was added later, matched neither branch, and flaked for months.
`App.lazy-coverage.test.ts` now enforces the rule by reading both files
(`?raw`, so no `node:fs` in browser-only apps/web), because a count in a
comment goes stale and a guard does not.

### global-counter-vs-live-worker

**A test asserting on a global counter or a "most recent" handle while
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

### in-body-dynamic-import

**`await import()` of a heavy module INSIDE a test body.** It charges the transform-and-load of that whole module graph to the per-test timeout (10s in `mcp-node`), which is ample on an idle machine and the first thing to blow once the full suite runs every project in parallel — aggregate import time there is measured in minutes. It reads as a mysterious load-dependent failure and the message names the test, not the import. Hoist it to a static top-level `import`, where the cost lands in the collection phase that no per-test timeout bounds. A dynamic import is only necessary when the file mocks what it imports (`vi.mock` + top-level `await import` is a different, legitimate shape), so **an in-body `await import()` with no `vi.mock` in the file is the tell**.

### held-element-across-remount

**An element reference held across an action that remounts it.**
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

### timed-out-browser-test-keeps-typing

**The one that multiplies the others: a timed-out browser test
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

Its companion, from the same run: **type ASCII.** A character with no
keycode (an em dash) is synthesized separately from the plain keystrokes
around it and is the one that goes missing under load — observed as
`'# Hello from an agent  edited here'`, both spaces present and the dash
gone, indistinguishable from an edit that never reached the backend.

### browser-project-in-flight

**Whether the whole browser PROJECT is in flight is itself a variable, and
the only one that mattered here.** The costliest `web-browser` test measured
1.5s with its file alone, 1.6s with the twelve IndexedDB-heavy page files
together, and 30–39s with all 115 browser files running — so an isolated
green proves nothing about the run that flakes, and a mutation check that
stays green in isolation has not exonerated the guard it removed (one did,
against a comment claiming the test would fail *every* run without it).
Two obvious causes were refuted by measurement rather than argument: cutting
`--maxWorkers` to 4 made it WORSE (33–39s, 40% more wall clock), and the
shared-IndexedDB theory died on the twelve-file run.

### seeded-identity-without-reset

**A fixed identity seeded into a persistent store with no per-test reset passes
once and fails its own second repetition.** The store outlives the test —
IndexedDB, OPFS, a data dir — so a test that seeds a fixed document path into
it finds that path already there on the next pass of `--repeats=3`, and the
keeper refuses: `DocumentPathTakenError: Document path "…" already exists`. Five
fresh processes pass it (each process claims a clean database); only the
in-process repeat reaches it, which is why it is first seen red on the PR's
`Repeat changed tests in-process (3x)` step, never in a local single run.
`local-list-documents-timing.browser.test.ts` was exactly this.

Fix: reset in `beforeEach` (`beforeEach(clearWhiteboardDb)`), not once in
`beforeAll` — a repeat reruns the test body, not the file's setup. A UNIQUE
per-run prefix (a counter folded into the path) is the other safe form.
Reproduce before pushing with `node .claude/scripts/stress-changed.mjs`, which
runs the job's two steps over the files you changed.

### teardown-wipes-dom

**A test's own teardown wiping the DOM out from under React.**
`afterEach(() => { document.body.innerHTML = '' })` leaves React roots
mounted on detached nodes; the NEXT render's reconciler then throws
unhandled `NotFoundError: removeChild ... not a child` — and vitest
reports every test in the file as PASSED while the file exits 1
("Unhandled Errors"). Measured on CI: `Tests 3 passed (3)`, `Errors 4
errors`, job red. Always unmount through testing-library's `cleanup()`;
a raw DOM wipe also races the shared setup's own cleanup, so in
isolation it reproduces only intermittently (1 in 17 reruns) while CI
load makes it reliable.

### environment-teardown-error

**`EnvironmentTeardownError: Cannot load '<module>' ... after the
environment was torn down`.** `teardown-wipes-dom`'s signature, another cause: a
file ended with DYNAMIC imports in flight (App's mount effect, lazy
pages), whose chains are static, so hoisting fixes nothing. The owner is the log's `originated in "<file>"`, not the module
named; mocking that module moves the error. Fixed in `web-jsdom` by
`vitest.setup.ts` awaiting `vi.dynamicImportSettled()`.

### mock-factory-outlives-test

**A `vi.mock` factory that outlives its own test.**
`VITEST_BROWSER_CONNECTION_CLOSED`, `[birpc] rpc is closed, cannot call
"resolveManualMock"`, a stack through playwright's `_onRoute`. The
signature of `teardown-wipes-dom` and `environment-teardown-error` — every
test PASSED, file exits 1 — with a third
cause: **`resolveManualMock` AWAITS the factory**, so it is in flight for
as long as the factory is, and a page closing under a live one blames no
test at all. Measured: a 1500ms factory in a body that finished in 1821ms,
last file in the shard, dead 25ms later. Reproduce by gating the factory
shut and failing one assertion. Resolve it INSIDE the test and await it,
and release it in `afterEach` too, or a failed assertion becomes this
instead of a message naming itself. Gate rather than shorten — the window
is a CONDITION, and a duration can close before the action under test.

### resize-in-fullscreen

**Resizing a window that is in fullscreen.** CDP refuses
(`Browser.setWindowBounds: ... restore it to normal state first`), vitest
never delivers the rejection, and the `await` does not settle — so the test
burns its whole 60s budget and reports `Test timed out in 60000ms`, naming
the test that asked rather than the state that refused, while the reason
arrives separately as an Unhandled Rejection belonging to no test. The
fullscreen is another FILE's, so the victim rotates, passes in isolation and
passes on a re-run of the same commit — two were written off as flakes on
that evidence. `apps/web/src/test-utils/viewport.ts` clears it at the top
document, which sees the owner whichever iframe it is; an `arch-lint` scan
keeps that the only way a test resizes.

### menu-still-dismissing

**Clicking a trigger whose menu is still dismissing.** The click is consumed and
the menu stays shut, so the failure reads as "the list does not contain this item" when no
list was ever opened — and raising the query's timeout only buys a slower identical failure.
Measured: `menus=0 expanded=false connected=true`. Wait for `[role="menu"]` to be gone before
re-opening.

### wait-on-the-row-not-the-pointer

**A test that waits for the observable a flow produces FIRST, then acts on its
half-finished state.** A delete here is four steps: clear the pointer, remove
the row, create the fresh row, repoint. A test that waited for "the store holds
one fresh row" finished between steps three and four — measured with a probe on
31 runs, the pointer was still null in 28 of them. The test then unmounted and
remounted a page, which read no pointer and seeded a SECOND document, ending
with two rows; the test passed, so nothing reported it. The same window, with
the pointer naming a document the index lacked instead of null, was the "The
canvas data could not be read." error screen that failed main three times in
four days. Wait for the LAST write of the flow (here the pointer naming the
row) and assert what the next step opened, not only that it rendered.
Mutation: without the pointer wait, the stronger final assertion failed 4 of 6.

### skip-waiting-ignored-on-the-runner

**The PWA update-lifecycle smoke (`verify`) timed out at "the page to reload
onto a controller" on the runner's Chrome stable and passed locally.** It was
the HARNESS, not the app: Playwright's locator click on the update toast's
Reload. Reproduced with Chrome 154 by pinning the smoke and two busy loops to
one core (3 of 8, 3 of 8, 3 of 6). In a failing run the waiting worker
receives the `SKIP_WAITING`, its own `skipWaiting()` stays pending with no
request in flight on either side, and stopping the OLD worker over DevTools
activates the new one at once; left alone, Chrome activates it after 300 s,
its lame-duck ceiling — the old worker never reports itself idle.

Ruled out one variable at a time, each eight starved rounds and 0 failures:
a raw-DevTools driver doing the same steps, then that driver with Playwright's
exact launch switches, its service-worker attachment, page network
instrumentation, its page auto-attach, a DevTools mouse-event click, a 3 s
settle after each load, and a message to the old worker while the new one
waits. Inside the Playwright smoke, replacing only the locator click with a
DOM `click()` on the same button took it to 0 of 16; disabling Playwright's
service-worker network inspection did not (3 of 8). So the smoke clicks
Reload through the DOM, which runs the same handler a person's click does —
0 of 10 starved after the change.

A timeout at that step still prints which document holds the page, every
worker's state, what the page posted to a worker, what is in flight, the
browser's view of every worker version, and what stopping the old worker
does. "Activates once the old one is stopped" is this shape again; "never
posted" is the toast's.
