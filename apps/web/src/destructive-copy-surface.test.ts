/**
 * The sentences in `lib/destructive-copy.ts` must exist in exactly one
 * place. This scans every source file under `apps/web/src` and fails when
 * any run of that copy is written out anywhere else.
 *
 * It is the source-scan variant from `.claude/rules/coverage-ledger.md` —
 * user-facing copy is not a union the type system enumerates, so the guard
 * reads the source instead. What it pins is narrower than a ledger and that
 * is the point: there is no model of confirmation copy to tally, only a
 * single-definition rule to hold.
 *
 * Why it exists rather than trusting a reader: correcting this copy once
 * meant editing six places, and a grep for the old phrasing found four.
 *
 * **It scans word runs, not whole sentences, because of what those two
 * misses were.** Both were tests asserting a MIDDLE FRAGMENT
 * (`/^The note moves to the Trash/`) — no pattern written from the
 * production sites matches that, and neither does a scan for the full
 * sentence. Measured: the first version of this file, which compared whole
 * fragments, flagged the three production sites and neither test. So the
 * probes are every {@link PROBE_WORDS}-word run of the copy, derived from
 * the copy itself rather than chosen by hand — a hand-picked "distinctive
 * phrase" would be one more string to keep in step, which is the class this
 * whole surface exists to remove.
 *
 * A test that wants to assert the copy imports the builder, so it passes
 * this scan for the same reason it can never drift.
 *
 * Source comes from `?raw` at build time, not `node:fs`: apps/web is
 * browser-only and `web-app-boundary.test.ts` enforces it.
 */
import { describe, expect, it } from 'vitest'
import {
  DESTRUCTIVE_COPY,
  type DestructiveActionId,
  type DestructiveDescription,
  destructiveCopyFragments,
} from './lib/destructive-copy.js'

const sources = import.meta.glob('./**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** Where the copy is allowed to appear, being the file that declares it. */
const DECLARATION = './lib/destructive-copy.ts'

/** This file quotes the copy only in prose above; excluded so the doc comment can stay concrete. */
const SELF = './destructive-copy-surface.test.ts'

/**
 * Short enough to catch a partial assertion, long enough that an ordinary
 * English sentence elsewhere in the app will not collide with it. Four
 * would flag "and restoring does not bring"; six would miss
 * `/^The note moves to the Trash/`, which is the case that motivated this.
 */
const PROBE_WORDS = 5

/**
 * Every PROBE_WORDS-long word run of `fragment`, sliced out of the original
 * so each probe is an exact substring — spacing and punctuation included.
 */
function wordRuns(fragment: string, size: number): string[] {
  const words = [...fragment.matchAll(/\S+/g)]
  const runs: string[] = []
  for (let i = 0; i + size <= words.length; i += 1) {
    const first = words[i]
    const last = words[i + size - 1]
    runs.push(fragment.slice(first.index, last.index + last[0].length))
  }
  return runs
}

function probesFor(build: DestructiveDescription): string[] {
  return destructiveCopyFragments(build).flatMap((fragment) => wordRuns(fragment, PROBE_WORDS))
}

const entries = Object.entries(DESTRUCTIVE_COPY) as [DestructiveActionId, DestructiveDescription][]

describe('destructive confirmation copy is declared once', () => {
  // A scan that stops matching reports itself as "everything is fine",
  // which is the failure mode this whole file exists to prevent. Assert the
  // fixture is present before asserting anything about it.
  it('scans a plausible number of source files', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(300)
    expect(sources[DECLARATION]).toBeDefined()
  })

  it.each(entries)('%s yields probes the declaration actually contains', (_id, build) => {
    const probes = probesFor(build)
    expect(probes.length).toBeGreaterThan(0)
    // If the declaration does not contain what we are about to grep for,
    // the grep is looking for something nothing produces.
    for (const probe of probes) {
      expect(sources[DECLARATION]).toContain(probe)
    }
  })

  it.each(entries)('%s appears in no file but the declaration', (_id, build) => {
    const offenders = probesFor(build).flatMap((probe) =>
      Object.entries(sources)
        .filter(([path]) => path !== DECLARATION && path !== SELF)
        .filter(([, source]) => source.includes(probe))
        .map(([path]) => `${path} carries "${probe}"`),
    )

    expect(
      [...new Set(offenders)].sort(),
      'destructive confirmation copy is written out somewhere other than lib/destructive-copy.ts — import DESTRUCTIVE_COPY there instead, in tests too',
    ).toEqual([])
  })
})
