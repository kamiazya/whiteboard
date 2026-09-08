/**
 * A jsdom test that logs a failure and carries on fails, unless it says which
 * failure it meant to provoke.
 *
 * The shape this exists for is an exception that is CAUGHT, logged, and
 * swallowed: the run keeps going and breaks somewhere unrelated. Measured on
 * CI, a crashed CodeMirror ViewPlugin disabled a CRDT binding for the life of
 * the view and the failure surfaced ten seconds later as an assertion about a
 * document NAME. `web-browser` has held that line since; this is the same line
 * for `web-jsdom`.
 *
 * **The claim is an ASSERTION, not an exemption.** `expectLoggedFailure` fails
 * when the record it names never arrived, so a test that stops producing its
 * degraded report fails rather than passing quietly — which is the direction a
 * bare allowlist cannot see. A test claiming `'network down'` is therefore
 * making the stronger statement it always meant to: not "noise here is fine"
 * but "this failure is reported, and here is the report".
 *
 * State on `globalThis` rather than in module scope, because there are TWO
 * instances of this module: the one `vitest.setup.ts` loads and the one a test
 * imports by path. Module-scoped state gave each its own copy, and the setup's
 * `afterEach` read its own untouched list — measured, the claiming test failed
 * holding the record it had just claimed.
 */
import { expect, vi } from 'vitest'

interface LoggedFailureState {
  seen: string[]
  claimed: string[]
}

const KEY = '__whiteboardJsdomLoggedFailures'
const globalScope = globalThis as Record<string, unknown>
globalScope[KEY] ??= { seen: [], claimed: [] } satisfies LoggedFailureState
const state = globalScope[KEY] as LoggedFailureState

/** Called by the setup's console interception. Not for tests. */
export function recordLoggedFailure(level: string, args: readonly unknown[]): void {
  state.seen.push(`${level}: ${args.map((arg) => String(arg)).join(' ')}`)
}

/**
 * Names a failure this test provokes on purpose, and asserts it was reported.
 *
 * Call it AFTER the action that should produce the record. `fragment` is
 * matched as a substring, so quote the part that identifies the failure rather
 * than the whole line — the tail usually carries an object dump whose spelling
 * is not this test's business.
 */
export async function expectLoggedFailure(fragment: string): Promise<void> {
  // Claimed BEFORE the wait, so a record that lands while we are waiting is
  // already spoken for — the report is usually a fire-and-forget catch on a
  // rejected promise, which resolves after the body that provoked it. Measured:
  // asserting synchronously saw `(none)` and let the record leak into the NEXT
  // test, failing two tests for one cause.
  state.claimed.push(fragment)
  await vi.waitFor(() => {
    expect(
      state.seen.filter((record) => record.includes(fragment)),
      `expected a logged failure containing ${JSON.stringify(fragment)}, but the records were:\n${state.seen.join('\n') || '(none)'}`,
    ).not.toHaveLength(0)
  })
}

/** Called by the setup's `afterEach`. Not for tests. */
export function takeUnclaimedLoggedFailures(): readonly string[] {
  const unclaimed = state.seen.filter(
    (record) => !state.claimed.some((fragment) => record.includes(fragment)),
  )
  state.seen.length = 0
  state.claimed.length = 0
  return unclaimed
}
