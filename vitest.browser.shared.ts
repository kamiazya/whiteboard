import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { playwright } from '@vitest/browser-playwright'
// Import the source file directly rather than `@kamiazya/whiteboard-mcp/test-utils`:
// that package export resolves to the built `dist/` output, which is gitignored
// and not produced by a plain `pnpm install` on a clean checkout (CI's browser
// job never builds packages/mcp-server before running Vitest).
import { resolveBrowserLaunchOptions } from './packages/mcp-server/src/server/browser-test-config.js'

/** Where a project's failure traces land, relative to its own root. */
const TRACES_DIR = 'tmp/vitest-traces'

/**
 * Set by `pnpm test:browser:trace` to record DOM snapshots as well.
 *
 * It is an env var rather than a CLI flag because a CLI flag cannot do it.
 * `--browser.trace=on` MERGES into the object below rather than replacing it
 * (measured: a config carrying `snapshots: false` still produced a zero-byte
 * `.network` under that flag), so once the default is off, nothing on the
 * command line can turn it back on. This is the switch that can.
 */
const SNAPSHOTS_VAR = 'WHITEBOARD_TRACE_SNAPSHOTS'

/**
 * The one definition of how this repo runs a Vitest browser project —
 * headless chromium via Playwright, launch options honouring
 * WHITEBOARD_CHROME_PATH, failure traces retained under the package's
 * `tmp/vitest-traces` (see AGENTS.md's browser-mode section). Three configs
 * spread this; before it existed each carried its own copy, and a knob
 * tuned in one (a trace setting, a connect timeout) silently missed the
 * other two.
 *
 * `viewport` is the one knob that legitimately differs per project:
 * component-scale projects render at 800x600, apps/web's page tests at
 * 1280x900.
 *
 * **Traces are kept for the MOST RECENT RUN ONLY**, cleared here as the
 * config loads. Nothing else ever deleted them, and each retained trace
 * carries screenshots and DOM snapshots: measured, one session's failing
 * runs left **19GB** under `apps/web/tmp/vitest-traces` and filled the
 * disk. What that looks like is worth stating, because it names nothing:
 * browser runs stop producing output and hang until the per-test timeout,
 * with no error mentioning space — the writes fail silently while `df`
 * still reports plenty of "Used". One run's worth is also all that is
 * useful: the traces you read are the ones from the run that just failed,
 * and a second run at the same path would overwrite them anyway.
 *
 * **DOM snapshots are off unless asked for**, which is a separate bound and
 * the one that stops a SINGLE run filling the disk — the clear above only
 * stops runs accumulating on each other. `snapshots: true` makes Playwright
 * record every resource body it served so the viewer can replay the DOM, and
 * under vitest browser mode vite serves the whole module graph of every page
 * under test. Measured on `apps/web`'s 16 page files (63 tests, all passing):
 * 302MB, of which the `.network` file is 284MB; the same subset with
 * snapshots off writes 7.5MB and a `.network` of zero. A whole `web-browser`
 * run measured 22GB.
 *
 * That is worth a paragraph because of how it fails rather than how big it
 * is. The disk runs out MID-RUN, and `tracing.stopChunk: ENOSPC` appears
 * once while what a reader actually sees is `Failed to fetch dynamically
 * imported module`, `Cannot connect to the iframe`, and a summary of
 * `774 passed` — against a true total of 929. 155 tests silently never ran,
 * and the smaller total reads like good news. Same shape as a mis-filtered
 * `--project`, reached by a different route.
 *
 * A failure's trace stays useful without them: the retained `.trace.zip` is
 * self-contained and still carries the screenshots, the action log and the
 * stacks (measured: 7 entries, 4 screenshots, 80KB against 96KB). What is
 * lost is DOM time-travel and the resource bodies, and it is one command
 * away — `pnpm test:browser:trace`, which is what that script is for.
 */
export function sharedBrowserTestConfig(
  options: {
    viewport?: { width: number; height: number }
    /**
     * The project's own root (`import.meta.dirname` at the call site), so
     * the stale traces cleared are the ones this project is about to
     * rewrite. Omitted, nothing is cleared — which is the old, unbounded
     * behavior, so a config that wants the bound has to say where it lives.
     */
    projectRoot?: string
  } = {},
) {
  if (options.projectRoot !== undefined) {
    rmSync(join(options.projectRoot, TRACES_DIR), { recursive: true, force: true })
  }
  return {
    enabled: true,
    headless: true,
    connectTimeout: 120_000,
    screenshotFailures: false,
    trace: {
      mode: 'retain-on-failure' as const,
      tracesDir: `./${TRACES_DIR}`,
      screenshots: true,
      snapshots: process.env[SNAPSHOTS_VAR] !== undefined,
    },
    viewport: options.viewport ?? { width: 800, height: 600 },
    provider: playwright({
      launchOptions: resolveBrowserLaunchOptions(process.env),
    }),
    instances: [{ browser: 'chromium' as const }],
  }
}
