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
      // Same escape set and the same `g` as vitest-projects.mjs. The flag is
      // redundant on one character and still belongs here: without it this
      // reads as a sanitiser that stops after the first match, which is what
      // CodeQL's js/incomplete-sanitization said about the first version.
      rx += pattern[i].replace(/[.+^${}()|[\]\\]/g, '\\$&')
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

/**
 * The DEFAULT BRANCH's analysis is the project's record — the ratings, the
 * issue counts, the coverage history every other number here is compared
 * against. Cancelling it when the next merge lands means main is never
 * analysed at all while merges arrive faster than an analysis takes.
 *
 * Measured before this guard: SIX consecutive main analyses cancelled in a
 * row, each killed by the following push. The dashboard kept answering from
 * an analysis over an hour old and nothing said so — a cancelled run is not
 * a failed one, so no check goes red and no notification fires. The only
 * tell was a triage whose effect refused to show up in the numbers.
 *
 * A PR is the opposite case and keeps cancelling: there, only the latest
 * push is worth analysing.
 */
describe('main is analysed, not cancelled by the next merge', () => {
  it('scopes cancel-in-progress so the default branch is exempt', () => {
    const workflow = readFileSync(join(ROOT, '.github/workflows/sonarqube.yml'), 'utf-8')
    const cancel = workflow.match(/^\s*cancel-in-progress:\s*(.+)$/m)?.[1]?.trim()

    expect(cancel, 'sonarqube.yml declares no cancel-in-progress').toBeDefined()
    expect(
      cancel,
      'a bare `true` cancels the default branch’s own analysis, which is the one nothing else can replace',
    ).not.toBe('true')
    // The condition has to name the default branch specifically; `false`
    // everywhere would also pass the line above while queueing every PR.
    expect(cancel).toContain('refs/heads/main')
  })
})

/**
 * The issue triage is a two-part declaration: an id list, and a `ruleKey` +
 * `resourceKey` pair per id. Sonar silently ignores a pair whose id is not in
 * the list, and silently ignores a listed id with no pair — so a typo in
 * either half excludes NOTHING while reading exactly like a triage that
 * worked. The file's own comment says a triage that quietly fails is worse
 * than no triage; this is that sentence made executable.
 */
describe('every issue-triage entry is reachable from the multicriteria list', () => {
  const text = readFileSync(join(ROOT, 'sonar-project.properties'), 'utf-8')
  const listed = (text.match(/^sonar\.issue\.ignore\.multicriteria=(.+)$/m)?.[1] ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '')
  const declared = new Map<string, Set<string>>()
  for (const [, id, field] of text.matchAll(
    /^sonar\.issue\.ignore\.multicriteria\.([^.=]+)\.(ruleKey|resourceKey)=/gm,
  )) {
    const fields = declared.get(id) ?? new Set<string>()
    fields.add(field)
    declared.set(id, fields)
  }

  // Both halves of the comparison below are derived by regex, so a pattern
  // that stopped matching would report "nothing is wrong" rather than fail.
  it('finds the declaration at all', () => {
    expect(listed.length).toBeGreaterThan(5)
    expect(declared.size).toBeGreaterThan(5)
  })

  it('gives every listed id both a ruleKey and a resourceKey', () => {
    const incomplete = listed.filter((id) => declared.get(id)?.size !== 2)
    expect(incomplete, 'listed but not fully declared — these exclude nothing').toEqual([])
  })

  it('lists every id that declares a pair', () => {
    const unlisted = [...declared.keys()].filter((id) => !listed.includes(id))
    expect(unlisted, 'declared but not listed — Sonar never reads these').toEqual([])
  })
})
