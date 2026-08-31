# Symptom → verdict

An index, not an explanation. Every entry's reasoning, measurement and fix
lives in `.claude/rules/integrator-flow.md` (always loaded) — this file exists
so a symptom string can be recognised before it is investigated.

Contents: browser suites · property tests · environment · order effects.

## Browser and jsdom suites

| What you see | Verdict |
|---|---|
| 9 `web-jsdom` tests fail on `object.stream is not a function` | Wrong Node major. `.node-version` pins 24; on 22 undici's `new Response(blobLike)` reaches for `.stream()`. Not a regression, and the diff is unrelated |
| 2–3 failures in one browser file | Triage the **earliest** only. A timed-out browser test keeps typing into the next one — observed as one test's text shuffled into another's. Re-measure before believing the later failures |
| a character is missing from typed text (an em dash, both spaces present) | Same overrun. Type ASCII in browser tests; a keycode-less character is synthesized separately and is the one that drops |
| `Re-optimizing dependencies` anywhere in the log | The tree moved under the running suite. Re-run on a quiet tree |
| every test PASSED and the file exits 1, `NotFoundError: removeChild` | A teardown doing `document.body.innerHTML = ''` while React roots are mounted. Use `cleanup()` |
| "the list does not contain this item" | No list was opened — the trigger was clicked while a menu was still dismissing. Wait for `[role="menu"]` to be gone |
| an assertion reads an empty value that was definitely typed | The element was remounted and the held reference is detached. Query inside the assertion |
| a test times out only under the full suite | An `await import()` of a heavy module inside a test body, or a `React.lazy` page racing a `findBy*` (testing-library's budget is 1000ms). Hoist the import |
| an assertion on a global counter or a "most recent" handle | Another test's `SharedWorker` is still alive. Scope every assertion to a handle the test itself minted |

## Property tests

| What you see | Verdict |
|---|---|
| `Test timed out in 5000ms ... (with seed=N)` | A **timeout**, not a property failure. `@fast-check/vitest` prints the seed in the test name either way. Do not hunt a counterexample; check whether the code under it got more expensive |
| a genuine shrunk counterexample | **Never a flake**, however random it looks. Reproduce with `withDefaults({ seed })`. A different seed passing means the generator missed the input |
| a reachability/density guard fails intermittently | The generator is too sparse. Denser domain plus a measured floor — never a pinned seed, never fewer assertions |

## Environment

| What you see | Verdict |
|---|---|
| `expected undefined to be an instance of Error` in an EACCES test | Running as root, where `chmod 000` denies nothing. `CAN_DENY_FILE_READ` probes this; it must be true on CI |
| `compose-figure.test.mjs` fails | ImageMagick absent. Confirm by running `main`'s own copy of that file before calling it a regression |
| a Preview URL contradicts a green test | The service worker is serving the old bundle. Unregister it and clear caches; a reload alone does not swap under `registerType: 'prompt'` |

## Order effects

A flake is only a flake once. The second occurrence of the same shape is a
root-cause lane, not another re-run — and a re-run is legitimate only to
confirm a base-branch failure, after the standing-down comment, or when the
job died before any test body ran.

Isolation proves nothing about the run that flaked: the costliest
`web-browser` test measures 1.5s alone and 30–39s with all 115 browser files
in flight. A mutation check that stays green in isolation has not exonerated
the guard it removed.
