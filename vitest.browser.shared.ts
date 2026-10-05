import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { playwright } from '@vitest/browser-playwright'
import type { BrowserCommand, TestProject } from 'vitest/node'
import { resolveBrowserLaunchOptions } from './vitest.browser.launch-options.js'

/** Where a project's failure traces land, relative to its own root. */
export const TRACES_DIR = 'tmp/vitest-traces'

/** A run records that it is live in the traces directory as `.live-<pid>`. */
const LIVE_MARKER = '.live-'

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
 * `commands.printReading(line)` from `vitest/browser`: one line on the runner's
 * stdout, for an instrument whose reading is its output. Console output from a
 * PASSING test is dropped by the `minimal` reporter vitest picks in an agent
 * session, and a test in the page has no `process.stdout` of its own to write
 * past it the way a node instrument does.
 */
const printReading: BrowserCommand<[line: string], void> = (_context, line) => {
  process.stdout.write(`${line}\n`)
}

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
 * **Traces are kept for the MOST RECENT RUN ONLY**, cleared when a run that
 * USES the project starts (`browserTracesSetup`, a per-project globalSetup).
 * Nothing else ever deleted them, and each retained trace
 * carries screenshots and DOM snapshots: measured, one session's failing
 * runs left **19GB** under `apps/web/tmp/vitest-traces` and filled the
 * disk. What that looks like is worth stating, because it names nothing:
 * browser runs stop producing output and hang until the per-test timeout,
 * with no error mentioning space — the writes fail silently while `df`
 * still reports plenty of "Used". One run's worth is also all that is
 * useful: the traces you read are the ones from the run that just failed,
 * and a second run at the same path would overwrite them anyway.
 *
 * **The clear is not done at config load, and it skips a directory another
 * live run holds.** Vitest loads EVERY project config on every invocation to
 * resolve `--project`, so a clear at load time wiped all four browser
 * projects' traces for a run that touched none of them (measured: an
 * `arch-lint-node` run deleted a sentinel under `packages/canvas-render` and
 * `apps/web`), and wiped the live trace directory of a browser run in flight.
 * That second case is not only lost traces: a concurrent run's `tracing.stopChunk`
 * then failed with ENOENT and a PASSING test was reported failed (2 failed of
 * 2, against 1 failed and 1 passed alone). Without the clear, two concurrent
 * runs of the same file completed identically three times in three, so the
 * shared directory is safe to write and only unsafe to delete.
 *
 * The directory name is deliberately unchanged: it is flattened into the
 * attachment name (`tmp-vitest-traces-<project>--chromium--…`), so a longer one
 * shrinks every browser test's title budget silently
 * (`browser-test-name-length.test.ts` reads it from here).
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
  options: { viewport?: { width: number; height: number } } = {},
) {
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
    commands: { printReading },
  }
}

function isLive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists and belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Takes `dir` for the run `self`: clears what an earlier run left unless
 * another LIVE run is writing there, then records `self` as live. Returns the
 * release, which removes only `self`'s record.
 *
 * Liveness is a process probe on a pid recorded in the directory, so a run
 * killed before it released leaves a record that stops counting the moment its
 * pid is gone. ponytail: a recycled pid keeps one dead run's record alive and
 * the directory un-cleared until that process exits, which costs disk and
 * nothing else; a lease with a heartbeat would close it if that ever matters.
 */
export function claimTracesDir(dir: string, self: number = process.pid): () => void {
  mkdirSync(dir, { recursive: true })
  const markers = readdirSync(dir).filter((name) => name.startsWith(LIVE_MARKER))
  const others = markers.filter((name) => {
    const pid = Number(name.slice(LIVE_MARKER.length))
    return pid !== self && Number.isInteger(pid) && isLive(pid)
  })
  if (others.length === 0) {
    for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true })
  }
  const marker = join(dir, `${LIVE_MARKER}${self}`)
  writeFileSync(marker, '')
  return () => rmSync(marker, { force: true })
}

/**
 * A project's `globalSetup`. Vitest runs it only for a project the run
 * includes, which is what a clear at config load could not know.
 */
export default function setup(project: TestProject): () => void {
  return claimTracesDir(join(project.config.root, TRACES_DIR))
}

/** What each browser project lists under `test.globalSetup`. */
export const browserTracesSetup = fileURLToPath(import.meta.url)
