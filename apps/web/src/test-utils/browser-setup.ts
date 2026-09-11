/**
 * Loads the app's real stylesheet into every browser test.
 *
 * Without it, Tailwind utility classes silently do nothing: a `className` of
 * `absolute bottom-3 z-10` computes to `position: static`, so chrome that the
 * app pins to an edge instead lands in ordinary document flow. Elements
 * positioned by INLINE style — the canvas scene's nodes — are unaffected, so
 * an unstyled dock and a correctly-positioned scene can physically collide
 * and a button becomes unclickable. Playwright reports that as a click that
 * never lands rather than a failed assertion, which reads like a hang and
 * points nowhere near the cause.
 *
 * The running app always loads this stylesheet, so a test that renders
 * without it is testing a layout no user ever sees. Loading it here removes
 * the per-file decision entirely.
 */

import { clearCatalogRecents } from '@kamiazya/whiteboard-facet-ui'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { configure } from '@testing-library/react'
import { afterEach } from 'vitest'
import '../index.css'
import { BROWSER_DEFAULT_SEGMENT } from '../lib/browser-idb.js'
import { setBrowserWorkspaceIdForTests } from '../lib/browser-workspace-id.js'

/**
 * A browser test renders production code that reads `getBrowserWorkspaceId()`
 * at its ordinary call sites, but no test runs the boot chain that resolves
 * it — so without a seed here the accessor's unresolved-state throw reaches
 * any test whose fixture is purely in-memory (a `LocalStoreDouble`, say)
 * rather than an IndexedDB one, where `claimIsolatedWhiteboardDb` seeds it.
 * A fixed per-file id, minted once, is what those call sites see; the same
 * default the jsdom setup installs, for the same reason.
 *
 * A test exercising the accessor's own unresolved/failed states resets it
 * explicitly.
 */
setBrowserWorkspaceIdForTests(generateDocumentId(), BROWSER_DEFAULT_SEGMENT)

/**
 * Testing Library's `findBy*`/`waitFor` default is 1000ms, which is a
 * fast-machine number: under parallel browser files it is routinely too
 * short for a portal to mount or an IndexedDB round trip to land. Ten tests
 * had already worked around it with a local `{ timeout: 10_000 }`, which is
 * the smell of a global default set too low.
 *
 * Like the test timeout, this is a ceiling rather than a delay — raising it
 * slows nothing down that succeeds.
 */
configure({ asyncUtilTimeout: 5_000 })

/**
 * Anything a browser test writes to `console.error` or `console.warn` fails
 * that test.
 *
 * The shape this exists for: an exception that is CAUGHT, logged, and
 * swallowed, leaving the run to fail somewhere else entirely. Measured on CI —
 * `@codemirror/view` caught a ViewPlugin exception, logged
 * `CodeMirror plugin crashed: Index out of bound. The given pos is 1, but the
 * length is 0`, and DISABLED that plugin for the life of the view. Every later
 * keystroke went into CodeMirror and never into the CRDT, no save was ever
 * scheduled, and the failure surfaced ten seconds later as
 * `expected 'untitled' to be 'Weekly review'` — an assertion about a document
 * NAME, in a different panel, naming neither the plugin nor the exception. The
 * one line that said what happened was a `stderr` the run printed and nothing
 * read.
 *
 * Strict, with no allowlist, because it costs nothing: measured over the whole
 * `web-browser` project — 235 files, 1237 tests — the ONLY record in the run is
 * the one `loro-binding.browser.test.tsx` provokes on purpose. `app-logger`
 * routes through `console[level]` under `import.meta.env.DEV`, which is what a
 * browser test runs as, so this catches the app's own swallowed-failure warns
 * (`log.warn('reading annotations failed', err)`) as well as React's and the
 * platform's.
 *
 * `web-jsdom` is deliberately NOT held to this yet, and the reason is a
 * measurement rather than caution: 219 records across 70 of its 3944 tests.
 * 138 of those are React's act-environment complaint, and the other 81 are
 * spread over 65 tests, most driving a failure path on purpose
 * (`canvas exploded`, `network down`, a refused registration). That is a ledger
 * of ~65 claims, not a free guard — see `testing-techniques/resources/
 * executable-rungs.md` for the numbers, the two real defects the measurement
 * turned up, and why a throwing guard cannot take this measurement at all.
 *
 * A test that means to provoke one calls `expectLoggedFailures()` and reads
 * what was caught.
 */

/**
 * On `globalThis`, not in module scope, because there are TWO instances of
 * this module: the one vitest loads as a `setupFiles` entry, and the one a
 * test that wants the escape hatch imports by path. Module-scoped state gave
 * each its own copy — the setup's `afterEach` read its own untouched flag and
 * failed the test that had just claimed the record. Measured: the provoking
 * test in `loro-binding.browser.test.tsx` failed with this guard's own message
 * while holding the exception it asked for.
 */
interface LoggedFailureState {
  seen: string[]
  expected: boolean
}
const LOGGED_FAILURE_KEY = '__whiteboardLoggedFailures'
const globalScope = globalThis as Record<string, unknown>
globalScope[LOGGED_FAILURE_KEY] ??= { seen: [], expected: false } satisfies LoggedFailureState
const loggedFailures = globalScope[LOGGED_FAILURE_KEY] as LoggedFailureState

/**
 * Claims the records this test provokes, and returns the live list. Also the
 * guard's own mutation check: a test that provokes one and finds this empty is
 * looking at a detector that stopped detecting.
 */
export function expectLoggedFailures(): readonly string[] {
  loggedFailures.expected = true
  return loggedFailures.seen
}

function record(level: string, args: unknown[]): void {
  loggedFailures.seen.push(`${level}: ${args.map((arg) => String(arg)).join(' ')}`)
}

// biome-ignore lint/suspicious/noConsole: intercepting these sinks IS the guard — a swallowed failure is reported here and nowhere else; both originals are called through, so nothing is swallowed by the guard itself
const realConsoleError = console.error.bind(console)
// biome-ignore lint/suspicious/noConsole: same interception
const realConsoleWarn = console.warn.bind(console)
console.error = (...args: unknown[]): void => {
  record('error', args)
  realConsoleError(...args)
}
console.warn = (...args: unknown[]): void => {
  record('warn', args)
  realConsoleWarn(...args)
}

afterEach(() => {
  const seen = [...loggedFailures.seen]
  const expected = loggedFailures.expected
  loggedFailures.seen.length = 0
  loggedFailures.expected = false
  if (seen.length > 0 && !expected) {
    throw new Error(
      `This test logged a failure and carried on. Something was caught and swallowed — the assertion that eventually breaks will be somewhere else.\n${seen.join('\n')}`,
    )
  }
})

// A facet catalog's "recently used" band is MODULE state — it has to be, so
// it survives the inspector closing — which means it also survives a test.
// Left alone it leaks a symbol one test picked into the next test's panel,
// where it shows up as an extra radiogroup nobody put there. Cleared here
// for the reason storage and fake timers are: what a test changes globally,
// the setup restores.
afterEach(clearCatalogRecents)
