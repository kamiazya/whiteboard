import { afterAll, expect } from 'vitest'
import { answered } from './core.js'

/**
 * Layer 1's guard against passing over nothing: a file under `src/okf/` that
 * this project runs against the Rust core must have had the core answer at
 * least one of its calls. A shim that silently fell back to the TypeScript
 * for every call would otherwise read as Rust passing every OKF suite.
 */
const LAYER_2 = /\.rust\.test\.ts$/

afterAll(() => {
  const file = expect.getState().testPath ?? ''
  if (!file.includes('/src/okf/') || LAYER_2.test(file)) return
  expect(
    answered.parseOkf + answered.serializeOkf,
    `${file}: the core answered nothing`,
  ).toBeGreaterThan(0)
})
