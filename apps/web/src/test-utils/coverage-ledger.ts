/**
 * A coverage ledger: the mechanism that keeps a test honest about a surface
 * that keeps growing.
 *
 * The problem it solves is not "too few tests". It is that a test modelling
 * a SURFACE — an editor's command set, its gesture events, its keyboard
 * catalog, its editing verbs — stays green when someone adds member N+1 and
 * never touches the test. Nothing fails. The suite reports the same number
 * of passing cases it did yesterday, over a surface that grew.
 *
 * A ledger closes that by making the surface's own type the key set, so
 * ADDING A MEMBER FAILS THE BUILD until someone writes down which it is:
 *
 *     const VERB_COVERAGE = {
 *       bold: 'covered',
 *       link: 'not modelled: opens a picker dialog, covered by link-picker.browser.test.tsx',
 *     } satisfies Record<VerbId, SurfaceCoverage>
 *
 * Four directions, and all four have to hold or the ledger decays into
 * decoration. The type system supplies two — a new union member is a
 * missing property, a removed one is an excess property — and this module
 * supplies the other two at runtime, the way this repo's other allowlists
 * are guarded from both sides (`ADAPTERS_REACHING_MECHANICS`,
 * `KNOWN_IMPORT_CYCLES`): a `covered` entry the run never produced is a
 * lie, and a `not modelled` entry the run DID produce is stale. Neither
 * can outlive what it claims.
 *
 * `not modelled` carries a reason for the same purpose `blastRadius: none:`
 * does — a bare exemption is the omission with a word in front of it.
 *
 * See `.claude/rules/coverage-ledger.md` for when a surface earns one, and
 * — the half that matters more — when it does not.
 */
import { expect } from 'vitest'

/** Whether a test exercises a member of the surface, or deliberately does not. */
export type SurfaceCoverage = 'covered' | `not modelled: ${string}`

/** A zeroed counter per ledger entry, ready to tick as the run produces them. */
export function emptyTally<K extends string>(
  ledger: Record<K, SurfaceCoverage>,
): Record<K, number> {
  return Object.fromEntries(Object.keys(ledger).map((key) => [key, 0])) as Record<K, number>
}

/**
 * Asserts a ledger against what the run actually did, from both runtime
 * directions.
 *
 * Call it from `afterAll`, once the run has finished tallying. Note vitest
 * reports an `afterAll` failure as a failed SUITE while the summary line
 * still reads "N passed" — the exit code is the truth.
 *
 * The messages name the fix, because the person reading one is usually
 * someone who just added a feature and has never opened the test file.
 *
 * @param what  Singular noun for one member, used in both messages —
 *              "EditorCommand kind", "shortcut", "editing verb".
 */
export function assertLedger<K extends string>(
  what: string,
  ledger: Record<K, SurfaceCoverage>,
  tally: Record<K, number>,
): void {
  for (const [key, coverage] of Object.entries(ledger) as [K, SurfaceCoverage][]) {
    if (coverage === 'covered') {
      expect(
        tally[key],
        `${what} "${key}" is marked covered but the run never produced it — either drive it from a command, or change its entry to "not modelled: <reason>"`,
      ).toBeGreaterThan(0)
    } else {
      expect(
        tally[key],
        `${what} "${key}" is marked "${coverage}" but the run produced it ${tally[key]} times — the entry is stale, mark it covered`,
      ).toBe(0)
    }
  }
}
