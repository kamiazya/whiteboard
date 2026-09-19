/**
 * The browser project for tests that leave the WINDOW in a state other tests
 * cannot tolerate.
 *
 * Exactly one thing qualifies today: entering real fullscreen. Chromium then
 * refuses CDP `Browser.setWindowBounds` — what `page.viewport` is — for the
 * next file in that browser instance that resizes, and vitest never delivers
 * the rejection, so the victim burns its whole timeout and names itself
 * rather than the cause.
 *
 * Why a separate PROJECT rather than a fix in the test or the helper: the
 * state is invisible and unreachable from the page. Measured, in this order:
 *
 * - `document.fullscreenElement` is null at the top document afterwards, and
 *   the window geometry is byte-identical to a clean run — so nothing on the
 *   page side can even detect it, let alone clear it.
 * - Retrying does not outlast it: instrumented at 15 attempts over 30s, every
 *   one refused, and it cleared only at the next FILE boundary.
 * - Launching with explicit `--window-size` / `--window-position` did not
 *   help (3 of 6 runs still failed, against a ~2-in-3 baseline).
 * - Nor did having the fullscreen file restore the bounds itself: that
 *   resize SUCCEEDS inside its own file and the next file is refused anyway,
 *   which is what says the state arises at the teardown boundary.
 *
 * What DID isolate it, and is why this file exists: skipping the one test
 * that really calls `requestFullscreen()` made 5 of 5 runs pass, where
 * keeping it failed 2 of 3 — and a neutral file in the same position passed
 * 4 of 4, so the fullscreen test is necessary rather than incidental.
 *
 * A separate project is a separate browser instance, so the sharing that the
 * defect needs cannot happen. `vitest-projects.test.ts` pins that a
 * `.window-state.browser.test.*` file lands here and NOT in `web-browser`.
 */

import { sharedBrowserTestConfig } from '../../vitest.browser.shared.js'
import base from './vitest.browser.config.js'

const baseTest = (base as { test?: Record<string, unknown> }).test ?? {}

export default {
  ...base,
  test: {
    ...baseTest,
    name: 'web-browser-window-state',
    include: ['src/**/*.window-state.browser.test.tsx', 'src/**/*.window-state.browser.test.ts'],
    // Spelled out because the base carries the mirror-image exclude, and
    // inheriting it left this project matching nothing at all — which reads
    // as "no such tests" rather than as a misconfiguration.
    exclude: [],
    // Called rather than inherited from the spread, for two reasons. It gives
    // this project its own browser config object instead of sharing the
    // base's, and `tools/checks/src/vitest-projects.mjs` detects a browser
    // project by READING the config source for this call — a spread is
    // invisible to it, so inheriting left the project classified as a node
    // one and tripped its own "a browser test file must never land in a
    // node/jsdom project" guard.
    browser: sharedBrowserTestConfig({
      viewport: { width: 1280, height: 900 },
      projectRoot: import.meta.dirname,
    }),
  },
}
