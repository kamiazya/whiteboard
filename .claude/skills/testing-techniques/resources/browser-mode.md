# Browser-mode tests

Three projects run in real headless Chromium through Playwright: `canvas-viewer-browser`,
`web-browser`, `canvas-render-browser` (`pnpm test:browser`). One config defines how —
`vitest.browser.shared.ts`'s `sharedBrowserTestConfig`, spread by all three, so a knob tuned
in one reaches the others. What follows is what a browser test has to know that a jsdom test
does not.

## Focus is a shared resource

Several browser pages run in parallel and only ONE holds OS focus. A test in an unfocused page
waits out its whole budget on a condition nothing can satisfy, and the victim rotates between
runs. This single fact explained a whole family of "timed out only under the full suite"
failures, and asking for focus back removed ten of eleven in one run.

- Put the caret with `focusEditable` (`apps/web/src/test-utils/focus-editable.ts`) rather than
  a click: `userEvent.click` waits for its target to be "stable", and a preview pane measuring
  real Canvas 2D text keeps settling under load. It takes a RESOLVER, not an element, and
  waits for `document.activeElement` to BE the editor — focus on an ancestor drops keystrokes.
- **A click followed by an absolute caret move is a focus click** and converts without changing
  what the test asserts. Measured on all seven `.cm-line` clicks in the repo.

## Typing

- **Type ASCII.** A character with no keycode (an em dash, a curly quote, CJK) is synthesized
  separately from the plain keystrokes around it and is the one that goes missing under load —
  observed as both spaces present and the dash gone, indistinguishable from an edit that never
  reached the backend. Lint rejects non-ASCII in `userEvent.keyboard` / `type` strings; use
  `paste()` when the exact character matters.
- **A timed-out test keeps typing.** Vitest abandons the test but the in-flight
  `userEvent.keyboard` stream nothing cancels lands in the NEXT test, interleaved with its own
  keystrokes (`'nadn dm oarne  atpyppeinndged line'`). One overrun fails two or three tests;
  triage the EARLIEST failure in a file first.

## Queries and locators

- **Query inside the assertion.** An element held across an action that remounts it reports
  the value it had when detached (`held.isConnected=false held.value=''`), and the message
  reads like lost input. Resolve from the page that owns it — `/title/i` matched on the
  OUTGOING page too. Not lint-guarded on purpose: ~90% of held references never cross a
  remount, so this one is reader judgement plus resolver-taking helpers.
- **Wait for a menu to be gone** (`[role="menu"]` absent) before clicking its trigger again;
  a click on a dismissing menu is consumed and "the list does not contain this item" is
  reported for a list that never opened. Raising the query timeout buys a slower identical
  failure.

### Strict locators

`browser.locators.exact` defaults to `true`: `page.getByText('Item')` matches an element whose
text is exactly `Item`, case-sensitively, and no longer `Item 1`. `toHaveTextContent(x)` is an
exact string comparison; partial or RegExp matching is the new matcher:

```ts
await expect.element(page.getByTestId('empty')).toMatchTextContent(/no comments/i)  // partial / RegExp
await expect.element(page.getByTestId('empty')).toHaveTextContent('No comments yet') // exact
```

`{ exact: false }` on one call, or `browser: { locators: { exact: false } }` project-wide,
restores substring matching. The installed build sets `locators.exact ??= true` (its type
comment still says `false`; the runtime wins). Why it matters here: the held-`/title/i`
shape bound to the OUTGOING page's title because a loose match had two candidates; a strict
match has one.

**Strictness moves an assertion onto the element it is actually about.** All three failures
the upgrade produced were the same shape — a whole-CONTAINER text assertion that had been
passing on a substring:

```ts
// was: the compose box's text is the quote PLUS the textarea and the button label,
// so this only ever passed because 'report' is a substring of 'reportComment'
await expect.element(page.getByTestId('comments-panel-compose')).toHaveTextContent('report')

// now: scoped to the quote, which is what the test's own comment says it checks
await expect
  .element(page.getByTestId('comments-panel-compose').getByText('report'))
  .toBeInTheDocument()
```

Locators chain (`getByTestId(...).getByText(...)`), and testing-library's `within(el)` does
the same for a `screen`-based test. Reach for `toMatchTextContent(/…/)` only when the
element genuinely holds a longer string you are matching part of — not to restore a
container assertion that was never about the container.

### Locator failure output already carries an ARIA tree

A locator miss prints the ARIA snapshot of the searched subtree — roles and accessible names,
which is exactly what `getByRole` / `getByLabelText` match against — above the HTML.
Measured on a forced miss:

```
VitestBrowserElementError: Cannot find element with locator: getByRole('menuitem', { name: 'Nope' })

ARIA tree:
- dialog "Settings":
  - button "Save"
  - list:
    - listitem: Alpha

HTML: …
```

`browser.locators.errorFormat` defaults to `'all'`, so this is on with no configuration;
`'aria'` only drops the HTML half and `'html'` drops the tree. Read the tree first when a
query misses — "no `menu` role anywhere" answers the dismissing-menu shape above in one
line, where the HTML dump does not.

## Teardown

- **Unmount through `cleanup()`**, never `document.body.innerHTML = ''`. A raw wipe leaves
  React roots on detached nodes; the NEXT render throws `NotFoundError: removeChild` as an
  unhandled error, and vitest reports every test PASSED while the file exits 1. Lint rejects
  the literal wipe; a wipe behind a named helper is past its floor.
- `web-browser`'s `browser-setup.ts` loads the app's real stylesheet: without it Tailwind
  classes compute to nothing, an unstyled dock collides with the scene, and Playwright reports
  a click that never lands — which reads like a hang.

## What cannot cancel an overrun

The test context's `{ signal }` is aborted on timeout, bail and Ctrl+C — and there is nothing
in browser mode to hand it to. `userEvent.keyboard` is `(text: string) => Promise<void>`, and
the whole `UserEvent` interface declares no signal or options bag on any method. So the
overrun that keeps typing into the next test cannot be cancelled from the test side; the
60s budget below is still the only bound on it. Use `{ signal }` where the TEST itself awaits
cancellable work (a `fetch`, a poll of your own), not for user events.

## Timeouts

`web-browser` runs at 60s (`testTimeout` and `hookTimeout`), sized at ~2.2× the slowest test
under a full 124-file run (27.0s; p99 9.4s, median 0.85s) and kept there to BOUND the
keystroke-leakage collateral above rather than to accommodate slowness. Fewer workers made the
run worse, not better (33–39s and 40% more wall clock), and the IndexedDB-contention theory
died on a twelve-file run at 1.6s. The full reasoning is the comment on `testTimeout` in
`apps/web/vitest.browser.config.ts`; re-measure before moving it.

## Titles

Keep a browser test's `describe` + `it` titles under **155 characters combined**. A failing
test's trace is copied under a name flattened from its path, and past the filesystem's
255-byte limit the copy throws `ENAMETOOLONG` in teardown — so vitest abandons the REST OF THE
FILE and the summary reports a smaller total that reads like good news (measured: `1 failed |
2 passed (6)` against `1 failed | 5 passed (6)`). Non-alphanumeric characters each become one
ASCII `-`, so `導線` costs two. `apps/web/src/browser-test-name-length.test.ts` enforces it,
and its arithmetic was re-measured against a real 5.0.0 attachment name (repo-root
`.vitest/attachments/`, 186 characters for an 86-character title).

## Traces

- Failure traces land under `<package>/tmp/vitest-traces`, kept for the MOST RECENT run only
  (the shared config clears them as it loads — one session left 19GB behind before that).
- **The default trace has no DOM view**: action log, stacks, screenshots. Recording the DOM
  through Playwright's `snapshots` means recording every resource vite served: 302MB against
  7.5MB on 16 page files, 22–23GB over a run, and the disk runs out MID-RUN with `774 passed`
  reported against a true 929. `pnpm test:browser:trace` turns snapshots on for ONE failing
  file; it traces every test, so never point it at the suite. The switch is the
  `WHITEBOARD_TRACE_SNAPSHOTS` env var because `--browser.trace=on` merges into the config
  object and cannot re-enable what the config turned off (measured).

### DOM replay without the resource recording: `browser.traceView`

```ts
export default defineConfig({
  test: {
    browser: {
      traceView: true,   // or { enabled: true, inlineImages: true, recordCanvas: true }
    },
  },
})
```

CLI: `vitest --browser.traceView`. Records a DOM snapshot at every interaction, assertion and
`page.mark`, and replays them step by step — interacted elements highlighted, failed steps
in red, keyboard navigation — in the browser UI, the Vitest UI and the HTML reporter.
Provider-independent, no separate viewer. `recordCanvas` includes canvas pixels but weakens
the replay iframe's sandbox (canvas redraw needs script execution); `inlineImages` embeds
image data so a single-file HTML report stays portable.

**The flag alone persists nothing.** Measured on `apps/web`'s 20 page files (79 tests): with
`--browser.traceView` and the default reporter, `.vitest/` held only one failure's Playwright
trace copy. The replays materialise through the HTML reporter (`--reporter=html`, which needs
`@vitest/ui`) or `vitest --ui`; `pnpm test:browser:replay` is the wired-up form and writes
`.vitest/index.html`.

**It is the DOM view the default trace lacks, at a size that does not matter.** Same 20 files:

| run | `.vitest/ui/html.meta.json.gz` | Playwright traces kept |
|---|---|---|
| HTML reporter only | 177KB | 0 (all passed) |
| HTML reporter + `traceView` | 774KB (7.8MB uncompressed, 251 snapshots) | 55KB (one failure) |

Against Playwright's `snapshots: true` at 302MB for 16 page files, the replay costs ~600KB
for every test in the subset, passing ones included — so it is a default, where the
Playwright DOM recording is a one-file tool. Runtime: two paired rounds on the same subset
measured 40.4s → 44.0s and 39.1s → 40.1s with the flag on, which is inside the noise of two
samples; re-measure before calling it free or costly. What it does not replace: the
Playwright trace still carries the network log and the provider's own screenshots.

Not a caveat about the flag, but found by the measurement: the 20-file page subset failed
`BrowserDocumentPage.rename`'s Escape test in three of seven runs — twice under `traceView`,
once without it, that time alongside a `delete-confirm` FOCUS test — and passed it alone
under the flag and in the quiet 196-file run. That is the focus-contention shape above, reached by running
exactly the IndexedDB page files together, and three occurrences is past the
root-cause-lane threshold (`resources/stability-checks.md`) if it shows on main.

## Dependency optimisation

Browser mode serves modules from the Vite dev server on demand, and under CI load the lazy
optimisation scan races the browser's first fetch — a spurious `Failed to fetch dynamically
imported module`. `apps/web/vitest.browser.config.ts`'s `optimizeDeps.include` prebundles what
every browser test transitively imports; `src/test-config/vitest-browser-optimize-deps.test.ts`
guards the list. And **never touch the tree while a browser suite runs**: a `pnpm install`
(even frozen, even changing nothing) logs `Re-optimizing dependencies because lockfile has
changed` and rebuilds the module graph under the running tests — 13 failing files out of a
green suite, reproducibly. Grep the run's log for `Re-optimizing` before diagnosing a broad
browser failure.
