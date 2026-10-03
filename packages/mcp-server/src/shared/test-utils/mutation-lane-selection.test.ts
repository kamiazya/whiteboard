import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fc, fcTest } from '@kamiazya/whiteboard-model/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { coveringTests } from '../../../scripts/mutation/covering-tests.mjs'
import strykerConfig from '../../../stryker.config.mjs'
import strykerVitestConfig from '../../../vitest.stryker.config.js'
import { STRYKER_PROPERTY_SEED } from '../../../vitest.stryker-setup.js'

/**
 * Stryker's vitest runner picks the tests that cover a mutant by TITLE: it
 * records the covering titles on a dry run and re-selects them by name for
 * each mutant. `@fast-check/vitest` writes the run's seed into a property's
 * title, `... (with seed=N)`, with N drawn fresh per process unless fast-check
 * has a global seed — so a property's title in the dry run matches nothing in
 * the mutant runs, and a mutant only the properties could kill is judged by
 * zero tests and reported as a survivor. The setup file pins the seed for this
 * lane alone so titles are stable across processes.
 */
describe('the mutation lane selects property tests by a stable title', () => {
  it('runs the setup file that pins the property seed', () => {
    const setup = strykerVitestConfig.test?.setupFiles
    expect([setup].flat()).toContain('./vitest.stryker-setup.ts')
  })

  // Importing the setup module above is what pins the seed in THIS file's
  // process, so the title is checked without running the lane.
  fcTest.prop([fc.nat()])('a property title carries the pinned seed, not a fresh one', () => {
    expect(expect.getState().currentTestName).toMatch(
      new RegExp(`\\(with seed=${STRYKER_PROPERTY_SEED}\\)$`),
    )
  })
})

const PACKAGE_DIR = resolve(import.meta.dirname, '../../..')

describe('the mutation lane runs the tests that reach a mutated module', () => {
  const included = [strykerVitestConfig.test?.include ?? []].flat()

  // The initial run is bounded and any failure in it ends the lane, so the
  // set is kept to what can kill a mutant. The compiler-resolved closure that
  // holds this list to the import graph is arch-lint's `mutation-lane.test.ts`.
  it('is the derivation over the mutate list, in the config', () => {
    expect(included).toEqual(coveringTests(strykerConfig.mutate, PACKAGE_DIR))
    // Reached, not assumed: an empty list would satisfy the line above.
    expect(included.length).toBeGreaterThan(50)
  })

  // An exclusion that names nothing the derivation selects is a reason that
  // outlived its test. Smoke and distribution tests are excluded by suffix
  // whatever the graph holds, so they are not held to this.
  it('excludes only tests the derivation selects', () => {
    const exclude: string[] = strykerVitestConfig.test?.exclude ?? []
    const named = exclude.filter((glob) => !/\.(smoke|distribution)\.test\.ts$/.test(glob))
    expect(named.length).toBeGreaterThan(3)
    for (const glob of named) {
      const pattern = new RegExp(
        `^(?:.*/)?${glob
          .replace(/^\*\*\//, '')
          .replaceAll('.', '\\.')
          .replaceAll('*', '[^/]*')}$`,
      )
      expect(
        included.filter((file) => pattern.test(file)),
        glob,
      ).not.toEqual([])
    }
  })

  // Listing every test again would satisfy a coverage check; the point of the
  // derivation is that most of the suite never reaches the mutated modules.
  it('leaves most of the suite out', () => {
    const everyTest = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) return everyTest(path)
        return entry.name.endsWith('.test.ts') ? [path] : []
      })
    expect(included.length).toBeLessThan(everyTest(join(PACKAGE_DIR, 'src')).length * 0.6)
  })
})

describe('coveringTests', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  function pkg(files: Record<string, string>): string {
    dir = mkdtempSync(join(tmpdir(), 'wb-covering-tests-'))
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true })
      writeFileSync(join(dir, name), text)
    }
    return dir
  }

  it('follows direct, transitive, dynamic, mocked and index imports, and no others', () => {
    const root = pkg({
      'src/mutated.ts': 'export const m = 1',
      'src/direct.test.ts': "import { m } from './mutated.js'",
      'src/helper.ts': "export * from './mutated.js'",
      'src/through-helper.test.ts': "import { m } from './helper.js'",
      'src/lazy.test.ts': "const x = await import('./helper.js')",
      'src/mocked.test.ts': "vi.mock('./mutated.js', () => ({}))",
      'src/nested/index.ts': "import '../helper.js'",
      'src/through-index.test.ts': "import { x } from './nested'",
      'src/unrelated.ts': 'export const u = 1',
      'src/unrelated.test.ts': "import { u } from './unrelated.js'",
      'src/string-only.test.ts': "const note = './mutated.js'",
    })
    expect(coveringTests(['src/mutated.ts'], root, 9)).toEqual([
      'src/direct.test.ts',
      'src/lazy.test.ts',
      'src/mocked.test.ts',
      'src/through-helper.test.ts',
      'src/through-index.test.ts',
    ])
  })

  it('stops at the depth it is given', () => {
    const root = pkg({
      'src/mutated.ts': 'export const m = 1',
      'src/near.ts': "import './mutated.js'",
      'src/far.ts': "import './near.js'",
      'src/near.test.ts': "import './near.js'",
      'src/far.test.ts': "import './far.js'",
    })
    expect(coveringTests(['src/mutated.ts'], root, 2)).toEqual(['src/near.test.ts'])
    expect(coveringTests(['src/mutated.ts'], root, 3)).toEqual([
      'src/far.test.ts',
      'src/near.test.ts',
    ])
  })

  it('terminates on an import cycle and does not list the mutated module as a test', () => {
    const root = pkg({
      'src/a.ts': "import './b.js'",
      'src/b.ts': "import './a.js'",
      'src/a.test.ts': "import './a.js'",
    })
    expect(coveringTests(['src/b.ts'], root)).toEqual(['src/a.test.ts'])
  })
})
