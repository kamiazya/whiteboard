import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fc, fcTest } from '@kamiazya/whiteboard-model/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { coveringTests, mutatedModules } from '../../../scripts/mutation/covering-tests.mjs'
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

const everyFile = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? everyFile(path) : [path]
  })

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

  // An exclusion that names nothing the lane could select is a reason that
  // outlived its test. A one-file run (`STRYKER_MUTATE`) can name any module,
  // so what the lane could select is the derivation over every module in
  // `src`, not over the configured list alone. Smoke and distribution tests
  // are excluded by suffix whatever the graph holds, so they are not held to
  // this.
  it('excludes only tests some run of the lane can select', () => {
    const exclude: string[] = strykerVitestConfig.test?.exclude ?? []
    const named = exclude.filter((glob) => !/\.(smoke|distribution)\.test\.ts$/.test(glob))
    expect(named.length).toBeGreaterThan(3)
    const modules = everyFile(join(PACKAGE_DIR, 'src'))
      .filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path))
      .map((path) => relative(PACKAGE_DIR, path))
    const selectable = coveringTests(modules, PACKAGE_DIR)
    for (const glob of named) {
      const pattern = new RegExp(
        `^(?:.*/)?${glob
          .replace(/^\*\*\//, '')
          .replaceAll('.', '\\.')
          .replaceAll('*', '[^/]*')}$`,
      )
      expect(
        selectable.filter((file) => pattern.test(file)),
        glob,
      ).not.toEqual([])
    }
  })

  // Listing every test again would satisfy a coverage check; the point of the
  // derivation is that most of the suite never reaches the mutated modules.
  it('leaves most of the suite out', () => {
    const everyTest = everyFile(join(PACKAGE_DIR, 'src')).filter((path) =>
      path.endsWith('.test.ts'),
    )
    expect(included.length).toBeLessThan(everyTest.length * 0.6)
  })
})

// A one-file run names its file twice — to Stryker's `--mutate` and to this
// lane's selection — because the vitest config is read in a process that
// never sees Stryker's arguments. Without the override the selection stays
// on the configured list and the named file's own tests never run.
describe('a one-file run selects the tests of the file it names', () => {
  it('takes the mutated modules from STRYKER_MUTATE when it is set', () => {
    const mutated = mutatedModules({ STRYKER_MUTATE: 'src/server/export/installed-fonts.ts' })
    expect(mutated).toEqual(['src/server/export/installed-fonts.ts'])
    expect(coveringTests(mutated, PACKAGE_DIR)).toContain(
      'src/server/export/installed-fonts.test.ts',
    )
  })

  it('reads the list the way --mutate does: comma-separated, line ranges dropped', () => {
    expect(mutatedModules({ STRYKER_MUTATE: ' src/a.ts:3-9 , src/b.ts,' })).toEqual([
      'src/a.ts',
      'src/b.ts',
    ])
  })

  it('falls back to the configured list when the override is unset or blank', () => {
    expect(mutatedModules({})).toEqual(strykerConfig.mutate)
    expect(mutatedModules({ STRYKER_MUTATE: '  ' })).toEqual(strykerConfig.mutate)
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
