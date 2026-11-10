import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import { afterEach, beforeEach, expect } from 'vitest'
import { answered, declined } from './core.js'
import { running, TYPESCRIPT_ONLY_TESTS } from './typescript-only.js'

/**
 * Layer 1's guard against passing over nothing, for the spatial suites: a file
 * under `src/spatial/` that this project runs against the Rust core must have
 * had the core answer at least one of its calls. A shim that silently fell back
 * to the TypeScript for every call would otherwise read as Rust passing every
 * spatial suite. Fed by every test the project runs, so a run filtered to a few
 * (`-t`) skips it.
 */
const inScope = (file: string): boolean =>
  file.includes('/src/spatial/') && !/\.rust\.test\.ts$/.test(file)

const typescriptOnly = new Set(TYPESCRIPT_ONLY_TESTS.map((t) => t.title))

beforeEach((context) => {
  declined.length = 0
  running.typescriptOnly = typescriptOnly.has(context.task.name)
})

afterEach((context) => {
  running.typescriptOnly = false
  if (context.task.result?.state === 'skip' || context.task.mode === 'skip') return
  const file = context.task.file.filepath
  if (!inScope(file)) return
  expect(declined, `${context.task.name}: the core declined`).toEqual([])
})

afterAllFloor('every test', () => {
  const file = expect.getState().testPath ?? ''
  if (!inScope(file)) return
  expect(
    answered.parseSpatial + answered.serializeSpatial,
    `${file}: the core answered nothing`,
  ).toBeGreaterThan(0)
})
