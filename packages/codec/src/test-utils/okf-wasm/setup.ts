import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import { afterEach, beforeEach, expect } from 'vitest'
import { answered, declined } from './core.js'
import { runsUnderRust } from './tolerated.js'

/**
 * Layer 1's guard against passing over nothing: a file under `src/okf/` that
 * this project runs against the Rust core must have had the core answer at
 * least one of its calls. A shim that silently fell back to the TypeScript
 * for every call would otherwise read as Rust passing every OKF suite. Fed by
 * every test the project runs, so a run filtered to a few (`-t`) skips it.
 */
const LAYER_2 = /\.rust\.test\.ts$/

// The tests left to the TypeScript, skipped here so a run shows them as
// skipped rather than dropping them from its count.
beforeEach((context) => {
  if (!runsUnderRust.test(context.task.name)) context.skip()
  declined.length = 0
})

// A decline is the TypeScript answering in the core's place, which a suite
// run against the core must not take for the core passing. No test is excused:
// the parity doc's "Declines" section lists what still declines, and none of
// it is provoked by an OKF suite.
afterEach((context) => {
  if (context.task.result?.state === 'skip' || context.task.mode === 'skip') return
  expect(declined, `${context.task.name}: the core declined`).toEqual([])
})

afterAllFloor([runsUnderRust], () => {
  const file = expect.getState().testPath ?? ''
  if (!file.includes('/src/okf/') || LAYER_2.test(file)) return
  expect(
    answered.parseOkf + answered.serializeOkf,
    `${file}: the core answered nothing`,
  ).toBeGreaterThan(0)
})
