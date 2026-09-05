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

### Strict locators `[v5]`

`browser.locators.exact` defaults to `true`: `page.getByText('Item')` matches an element whose
text is exactly `Item`, case-sensitively, and no longer `Item 1`. `toHaveTextContent(x)` is an
exact string comparison; partial or RegExp matching is the new matcher:

```ts
await expect.element(page.getByTestId('empty')).toMatchTextContent(/no comments/i)  // partial / RegExp
await expect.element(page.getByTestId('empty')).toHaveTextContent('No comments yet') // exact
```

`{ exact: false }` on one call, or `browser: { locators: { exact: false } }` project-wide,
restores substring matching. Why it matters here: the held-`/title/i` shape bound to the
OUTGOING page's title because a loose match had two candidates; a strict match has one. On
this tree: 2 RegExp `toHaveTextContent` calls (`CommentsPanel.browser.test.tsx`) and ~1389
`getBy*` sites to re-read at the upgrade.

### Locator failure output as an ARIA tree `[v5]`

```ts
export default defineConfig({
  test: { browser: { locators: { errorFormat: 'aria' } } }, // 'html' | 'aria' | 'all'
})
```

On a miss, the error prints the ARIA snapshot of the searched subtree — roles and accessible
names, which is exactly what `getByRole` / `getByLabelText` match against, and far shorter
than the raw HTML. `'all'` prints both.

## Teardown

- **Unmount through `cleanup()`**, never `document.body.innerHTML = ''`. A raw wipe leaves
  React roots on detached nodes; the NEXT render throws `NotFoundError: removeChild` as an
  unhandled error, and vitest reports every test PASSED while the file exits 1. Lint rejects
  the literal wipe; a wipe behind a named helper is past its floor.
- `web-browser`'s `browser-setup.ts` loads the app's real stylesheet: without it Tailwind
  classes compute to nothing, an unstyled dock collides with the scene, and Playwright reports
  a click that never lands — which reads like a hang.

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
ASCII `-`, so `導線` costs two. `apps/web/src/browser-test-name-length.test.ts` enforces it;
Vitest 5 moves attachments to `.vitest/attachments/`, so the budget is re-measured at upgrade.

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

### DOM replay without the resource recording: `browser.traceView` `[v5]`

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
in red, keyboard navigation — in the browser UI, the Vitest UI and the HTML reporter, for
local runs and CI failures alike. Provider-independent, no separate viewer. Artifacts land
under `.vitest/`. `recordCanvas` includes canvas pixels but weakens the replay iframe's
sandbox (canvas redraw needs script execution); `inlineImages` embeds image data so a
single-file HTML report stays portable. Pair it with the single-file HTML reporter
(`resources/configuration.md`) to upload one `index.html` from CI.

Why it matters here: this records DOM snapshots rather than every served resource, which is
what made Playwright's `snapshots: true` cost 302MB per 16 files. Whether it is the missing
DOM view at a fraction of the size is a HYPOTHESIS until measured on the same subset
(`resources/vitest-upgrade.md`).

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
