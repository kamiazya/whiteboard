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
 * A crashed CodeMirror ViewPlugin fails the test that caused it.
 *
 * `@codemirror/view` catches an exception thrown by a plugin's update, logs
 * `CodeMirror plugin crashed: …` and DISABLES that plugin for the life of the
 * view. Nothing throws, nothing rejects, and the editor keeps accepting input
 * — so a CRDT binding that dies this way leaves a pane that looks perfectly
 * healthy and reaches no document at all.
 *
 * What that costs without this guard, measured on CI: the markdown binding
 * crashed with `Index out of bound. The given pos is 1, but the length is 0`,
 * every later keystroke went only into CodeMirror, no save was ever scheduled,
 * and the failure surfaced ten seconds later as `expected 'untitled' to be
 * 'Weekly review'` — an assertion about a document NAME, in a different panel,
 * naming neither the plugin nor the exception. The line that said what
 * happened was a `stderr` the run printed and nothing read.
 *
 * Narrow on purpose: only this marker, not `console.error` at large. A test
 * that provokes a crash deliberately calls `expectCodeMirrorPluginCrash()`
 * and reads what was caught.
 */
const CODEMIRROR_CRASH_MARKER = 'CodeMirror plugin crashed'

/**
 * On `globalThis`, not in module scope, because there are TWO instances of
 * this module: the one vitest loads as a `setupFiles` entry, and the one a
 * test that wants the escape hatch imports by path. Module-scoped state gave
 * each its own copy — the setup's `afterEach` read its own untouched flag and
 * failed the test that had just claimed the crash. Measured: the provoking
 * test below failed with the guard's own message while holding the exception
 * it asked for.
 */
interface CodeMirrorCrashState {
  seen: string[]
  expected: boolean
}
const CRASH_STATE_KEY = '__whiteboardCodeMirrorCrashes'
const globalScope = globalThis as Record<string, unknown>
globalScope[CRASH_STATE_KEY] ??= { seen: [], expected: false } satisfies CodeMirrorCrashState
const crashState = globalScope[CRASH_STATE_KEY] as CodeMirrorCrashState

/**
 * Claims the crashes this test provokes, and returns the live list. Also the
 * guard's own mutation check: a test that provokes one and finds this empty is
 * looking at a detector that stopped detecting.
 */
export function expectCodeMirrorPluginCrash(): readonly string[] {
  crashState.expected = true
  return crashState.seen
}

// biome-ignore lint/suspicious/noConsole: intercepting this sink IS the guard — @codemirror/view reports a crashed plugin here and nowhere else
const realConsoleError = console.error.bind(console)
// biome-ignore lint/suspicious/noConsole: same interception; the original is called through, so nothing is swallowed
console.error = (...args: unknown[]): void => {
  if (args.some((arg) => typeof arg === 'string' && arg.includes(CODEMIRROR_CRASH_MARKER))) {
    crashState.seen.push(args.map((arg) => String(arg)).join(' '))
  }
  realConsoleError(...args)
}

afterEach(() => {
  const seen = [...crashState.seen]
  const expected = crashState.expected
  crashState.seen.length = 0
  crashState.expected = false
  if (seen.length > 0 && !expected) {
    throw new Error(
      `A CodeMirror plugin crashed and was silently disabled — every later edit in that view reached nothing.\n${seen.join('\n')}`,
    )
  }
})
