import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import type { RunnerTask } from 'vitest'
import { afterEach, beforeAll, beforeEach, expect } from 'vitest'
import { answered, declined } from './core.js'
import { DECLINE_SHAPE, DECLINES_FILE, EXPECTED_DECLINES } from './declines.js'
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
// run against the core must not take for the core passing.
afterEach((context) => {
  if (context.task.result?.state === 'skip' || context.task.mode === 'skip') return
  const expected = EXPECTED_DECLINES.get(context.task.name)
  if (expected === undefined) {
    expect(declined, `${context.task.name}: the core declined`).toEqual([])
  } else {
    expect(
      declined.length,
      `${context.task.name}: expected the ${expected} decline`,
    ).toBeGreaterThan(0)
    const { fn, reason } = DECLINE_SHAPE[expected]
    for (const decline of declined) {
      expect(decline.fn, `${context.task.name}: a decline other than ${expected}`).toBe(fn)
      expect(decline.reason, `${context.task.name}: a decline other than ${expected}`).toMatch(
        reason,
      )
    }
  }
})

afterAllFloor([runsUnderRust], () => {
  const file = expect.getState().testPath ?? ''
  if (!file.includes('/src/okf/') || LAYER_2.test(file)) return
  expect(
    answered.parseOkf + answered.serializeOkf,
    `${file}: the core answered nothing`,
  ).toBeGreaterThan(0)
})

const names = (task: RunnerTask): string[] =>
  'tasks' in task ? task.tasks.flatMap(names) : [task.name]

// Every test this file declares, a `-t` filter's left-out ones included.
let collected: ReadonlySet<string> = new Set()
let filepath = ''
// biome-ignore lint/correctness/noEmptyPattern: vitest reads the hook's first parameter as a fixture pattern, so it must be a destructuring one
beforeAll(({}, file) => {
  collected = new Set(names(file))
  filepath = 'filepath' in file ? file.filepath : ''
})

// An entry is only looked up when its test runs, so one whose test was renamed
// or deleted would outlive it.
afterAllFloor([runsUnderRust], () => {
  if (!filepath.endsWith(DECLINES_FILE)) return
  const stale = [...EXPECTED_DECLINES.keys()].filter((title) => !collected.has(title))
  expect(stale, `${DECLINES_FILE}: allowed declines naming no test`).toEqual([])
})
