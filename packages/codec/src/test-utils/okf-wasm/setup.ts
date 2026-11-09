import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import { beforeEach, expect } from 'vitest'
import { answered } from './core.js'
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
})

afterAllFloor([runsUnderRust], () => {
  const file = expect.getState().testPath ?? ''
  if (!file.includes('/src/okf/') || LAYER_2.test(file)) return
  expect(
    answered.parseOkf + answered.serializeOkf,
    `${file}: the core answered nothing`,
  ).toBeGreaterThan(0)
})
