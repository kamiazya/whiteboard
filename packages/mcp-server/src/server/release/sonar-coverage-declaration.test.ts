// sonar-project.properties' `sonar.coverage.exclusions` is a HAND-WRITTEN
// complement of what `pnpm coverage` actually measures, and a hand-written
// complement drifts the moment someone adds a root-level config file or a new
// scripts/ directory. The drift is silent in the worst way: Sonar reports a
// file with no lcov record as UNCOVERED rather than unmeasured, so the new
// file arrives at 0%, drags the coverage number down, and fails a quality gate
// for being untested when it is not. That is exactly how this list came to be
// written — run-coverage.mjs is exercised by four cases in
// vitest-projects.test.ts and still showed `0.0% Coverage on New Code`.
//
// So the declaration is checked against the tree rather than trusted: every
// tracked source file the scanner analyses is either MEASURED (under the src/
// of a package whose project the coverage run derives) or NAMED by an
// exclusion pattern. Neither side is allowed to be empty, because a matcher
// that matches nothing would pass this by finding no leftovers at all.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../../../../..')
const RUN_COVERAGE_MODULE_PATH = join(ROOT, 'tools/checks/src/run-coverage.mjs')
const VITEST_PROJECTS_MODULE_PATH = join(ROOT, 'tools/checks/src/vitest-projects.mjs')

/**
 * SonarQube path-pattern semantics, and only the three forms this file uses:
 * `**​/` is zero or more directories, `**` is any run of characters, `*` stays
 * inside one segment. Deliberately not a general glob engine — an unsupported
 * form has to fail visibly in the fixtures below rather than silently match
 * nothing, which in a complement check reads as success.
 */
function sonarPatternToRegExp(pattern: string): RegExp {
  let rx = ''
  for (let i = 0; i < pattern.length; ) {
    if (pattern.startsWith('**/', i)) {
      rx += '(?:[^/]+/)*'
      i += 3
    } else if (pattern.startsWith('**', i)) {
      rx += '.*'
      i += 2
    } else if (pattern[i] === '*') {
      rx += '[^/]*'
      i += 1
    } else {
      rx += pattern[i].replace(/[.+^${}()|[\]\\]/, '\\$&')
      i += 1
    }
  }
  return new RegExp(`^${rx}$`)
}

function coverageExclusionPatterns(): string[] {
  const text = readFileSync(join(ROOT, 'sonar-project.properties'), 'utf-8')
  const match = /^sonar\.coverage\.exclusions=((?:.*\\\n)*.*)$/m.exec(text)
  if (!match) throw new Error('sonar-project.properties declares no sonar.coverage.exclusions')
  return match[1]
    .replace(/\\\n/g, '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '')
}

/** Tracked files the scanner analyses as SOURCE: sonar.test.inclusions claims
 *  the test files, and sonar.exclusions drops docs/ and the declarations. */
function analysedSourceFiles(): string[] {
  return execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.mjs'], {
    cwd: ROOT,
    encoding: 'utf-8',
  })
    .split('\n')
    .filter((f) => f !== '')
    .filter((f) => !f.includes('.test.') && !f.includes('.bench.') && !f.endsWith('.d.ts'))
    .filter((f) => !f.startsWith('docs/') && !f.startsWith('tests/'))
}

/** The directories `pnpm coverage` measures: the root of every project the run
 *  derives. Its coverage include is `**​/src/**`, resolved against each of
 *  them — see vitest.config.ts, where that glob is the whole trap. */
async function measuredProjectDirs(): Promise<string[]> {
  const { deriveCoverageProjectNames } = (await import(
    pathToFileURL(RUN_COVERAGE_MODULE_PATH).href
  )) as { deriveCoverageProjectNames: (root: string) => string[] }
  const { readVitestProjects } = (await import(
    pathToFileURL(VITEST_PROJECTS_MODULE_PATH).href
  )) as {
    readVitestProjects: (root: string) => Array<{ configPath: string; name: string | undefined }>
  }
  const derived = new Set(deriveCoverageProjectNames(ROOT))
  return [
    ...new Set(
      readVitestProjects(ROOT)
        .filter((p) => p.name !== undefined && derived.has(p.name))
        .map((p) => p.configPath.slice(0, p.configPath.lastIndexOf('/'))),
    ),
  ]
}

describe('sonar.coverage.exclusions is the complement of what pnpm coverage measures', () => {
  it('matches the three pattern forms the declaration uses, and only those', () => {
    expect(
      sonarPatternToRegExp('**/scripts/**').test('packages/mcp-server/scripts/dev/x.mjs'),
    ).toBe(true)
    // `**/` is ZERO or more directories: a root-level file matches too. The
    // first version of this matcher required the slash and reported
    // vitest.config.ts as an uncovered leftover it had already excluded.
    expect(sonarPatternToRegExp('**/vitest.*.ts').test('vitest.config.ts')).toBe(true)
    expect(sonarPatternToRegExp('tools/*.mjs').test('tools/check-pr-title.mjs')).toBe(true)
    // `*` stays inside a segment.
    expect(sonarPatternToRegExp('tools/*.mjs').test('tools/checks/src/run-coverage.mjs')).toBe(
      false,
    )
  })

  it('names every analysed file the coverage run does not measure', async () => {
    const dirs = await measuredProjectDirs()
    expect(
      dirs.length,
      'no measured project dirs — the check would pass vacuously',
    ).toBeGreaterThan(10)
    const patterns = coverageExclusionPatterns().map(sonarPatternToRegExp)
    expect(patterns.length, 'no exclusion patterns parsed').toBeGreaterThan(0)

    const isMeasured = (file: string) =>
      dirs.some(
        (dir) => file.startsWith(`${dir}/`) && /(^|\/)src\//.test(file.slice(dir.length)),
      ) && !file.includes('/src/vendor/')

    const leftover = analysedSourceFiles().filter(
      (file) => !isMeasured(file) && !patterns.some((rx) => rx.test(file)),
    )

    expect(
      leftover,
      'these are analysed by SonarQube, measured by nothing, and named by no exclusion — each will report 0% coverage and drag the gate down. Add it to sonar.coverage.exclusions, or bring it under a measured src/.',
    ).toEqual([])
  })
})
