// What starts the browser keeper's file sweep is answered in one module,
// `file-sweep-schedule.ts`: a reader looking for "when does the sweep run"
// opens it and finds every trigger, and the dynamic import that keeps the
// scan (and loro-crdt with it) out of the entry chunk is written once, with
// its logging beside it. Any other production module reaching the sweep's
// code — by a dynamic import or a value import — is a trigger outside it.
//
// Source is captured at build time via `?raw` rather than read at runtime, so
// this stays free of `node:fs` — apps/web is browser-only (see
// web-app-boundary.test.ts).

import { describe, expect, it } from 'vitest'

const sources = import.meta.glob(
  ['../**/*.ts', '../**/*.tsx', '!../**/*.test.ts', '!../**/*.test.tsx'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>

const HOME = './file-sweep-schedule.ts'

// Assembled from pieces so this file does not contain the text it forbids.
const SWEEP_MODULE = `['"][^'"]*${'browser-file-sweep'}(?:\\.js)?['"]`
const REACHES_THE_SWEEP = new RegExp(
  `${'import'}\\(\\s*${SWEEP_MODULE}\\s*\\)|^${'import'}\\s+(?!type\\b)[^;]*?\\bfrom\\s+${SWEEP_MODULE}`,
  'm',
)

function fileOf(key: string): string {
  return key.replace(/^\.\.\/lib\//, './')
}

describe('the file sweep is started from one module', () => {
  it('recognises a trigger and not a type import (self-test)', () => {
    const at = (spec: string) => spec.replace('SWEEP', `./${'browser-file-sweep'}.js`)
    expect(REACHES_THE_SWEEP.test(at(`void import('SWEEP').then(run)`))).toBe(true)
    expect(REACHES_THE_SWEEP.test(at(`import { sweepUnreferencedFiles } from 'SWEEP'`))).toBe(true)
    expect(REACHES_THE_SWEEP.test(at(`import type { BrowserFileSweepResult } from 'SWEEP'`))).toBe(
      false,
    )
  })

  it('reaches the source it is guarding', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(200)
    // The subject is present: the home itself holds the trigger.
    const home = Object.entries(sources).find(([key]) => fileOf(key) === HOME)?.[1] ?? ''
    expect(REACHES_THE_SWEEP.test(home)).toBe(true)
  })

  it('is reached by no production module but the schedule', () => {
    const offenders = Object.entries(sources)
      .filter(([key, source]) => fileOf(key) !== HOME && REACHES_THE_SWEEP.test(source))
      .map(([key]) => key)
    expect(
      offenders,
      'start the sweep through file-sweep-schedule.ts (scheduleFileSweep / sweepAfterPurge)',
    ).toEqual([])
  })
})
