// A browser test that fails writes a Playwright trace, and vitest then COPIES
// that trace into the repo-root `.vitest/attachments/` under a name flattened
// from its path. When that name exceeds the filesystem's 255-byte limit the
// copy throws ENAMETOOLONG — and the throw lands in the file's teardown, so
// vitest abandons the REST OF THE FILE.
//
// Re-measured on vitest 5.0.0 (the directory moved from `.vitest-attachments/`
// at that upgrade): one real failure's copy was 186 characters for an 86-
// character sanitized title, which is exactly the fixed overhead below plus the
// title — the name shape did not change, so neither did the budget.
//
// Measured, by forcing one failure in BrowserDocumentPage.rename twice:
//
//   failed test with a 194-char name -> ENAMETOOLONG, "1 failed | 2 passed (6)"
//   failed test with a  58-char name -> no error,     "1 failed | 5 passed (6)"
//
// Three tests silently did not run, and the run reported a smaller total —
// which reads like good news. The trace itself is fine either way (it is
// written to tmp/vitest-traces first, and only the copy fails), so the cost is
// entirely the lost coverage.
//
// THE PROJECT NAME IS PART OF THE FILENAME, so the budget is per project, not
// one number. The guard once read only `apps/web`'s `*.browser.test.tsx` and
// hard-coded `web-browser`; the other three browser projects have longer names
// and nothing read them. Measured on the boundary, one forced failure each,
// the next test in the file passing or abandoned:
//
//   canvas-viewer-browser     145 chars -> "1 failed | 1 passed (2)"
//                             146 chars -> ENAMETOOLONG, "1 failed (2)"
//   web-browser-window-state  142 chars -> "1 failed | 1 passed (2)"
//                             143 chars -> ENAMETOOLONG, "1 failed (2)"
//
// which is exactly `166 - project name length` (155 for `web-browser`, 145 for
// the two `canvas-*` projects, 142 for the window-state one). At the time it
// was widened, `CanvasViewer.browser.test.tsx` carried a 171-character title and
// `determinism.browser.test.ts` two at 151-152, each over its project's budget
// while the old guard reported a clean tree.
//
// Which project owns a file is READ from the vitest configs through the same
// parser `ci-verify-coverage` uses (`tools/checks`), include and exclude globs
// both, so a project renamed or a glob moved changes the budget instead of
// leaving a constant that is no longer true. A browser file no project owns
// fails here too: it would never run, and `vitest-projects.test.ts` pins that
// from the other side.

import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { listTestFiles, TEST_SCAN_DIRS } from './test-scan-dirs.js'

interface ProjectGlobs {
  dir: string
  name: string | undefined
  isBrowser: boolean
  include: string[]
  exclude: string[]
}

interface VitestProjectsModule {
  readProjectTestGlobs: (repoRoot: string) => ProjectGlobs[]
  testGlobMatches: (pattern: string, relPath: string) => boolean
}

// A computed specifier, which the lazy-import scan recognises as the
// by-path loader it is: `tools/checks` is dependency-free plain `.mjs`.
const { readProjectTestGlobs, testGlobMatches } = (await import(
  pathToFileURL(join(REPO_ROOT, 'tools/checks/src/vitest-projects.mjs')).href
)) as VitestProjectsModule

/** ext4/APFS both stop at 255 BYTES for a single path component. */
const NAME_LIMIT = 255

/**
 * The name as it reaches the filesystem. vitest replaces every non-alphanumeric
 * CHARACTER with one ASCII `-`, including multi-byte ones, so the sanitized
 * form is pure ASCII and its length in characters IS its length in bytes.
 *
 * Measured against a real attachment name: the title path
 * `…markdown 導線 (browser — real IndexedDB)-…-is editable…` is 207 characters
 * and 213 UTF-8 bytes raw, and landed on disk as 207 characters — `導`, `線`
 * and `—` each cost one dash, not three. Counting the raw title's bytes would
 * therefore reject titles that fit.
 */
const sanitize = (title: string): string => title.replace(/[^a-zA-Z0-9]/g, '-')

/**
 * What the attachment name costs before the test's own title:
 * `tmp-vitest-traces-` (the flattened `tracesDir`), `<project>--chromium--`
 * (project + browser), and a `-0-0-trace-zip-<40-char sha>.zip` suffix.
 */
function titleBudget(projectName: string): number {
  const fixedOverhead =
    'tmp-vitest-traces-'.length +
    `${projectName}--chromium--`.length +
    '-0-0-trace-zip-'.length +
    40 +
    '.zip'.length
  return NAME_LIMIT - fixedOverhead
}

/**
 * Every `describe`/`it` title in a file, with nesting resolved by brace depth.
 * Titles built from a template with a substitution are skipped — their length
 * is not knowable here, and none of them are near the limit.
 */
function titlePaths(source: string): string[] {
  const paths: string[] = []
  const stack: { title: string; depth: number }[] = []
  let depth = 0
  const pattern = /\b(describe|it)(?:\.\w+)?\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2|[{}]/g
  for (const match of source.matchAll(pattern)) {
    const token = match[0]
    if (token === '{') {
      depth += 1
      continue
    }
    if (token === '}') {
      depth -= 1
      continue
    }
    const [, kind, , title] = match
    if (title === undefined || title.includes('${')) continue
    // A SIBLING describe opens at the same depth as the one that just closed,
    // so drop anything at or below this depth before pushing — otherwise every
    // sibling accumulates and the reported title path is one nobody wrote.
    while (stack.length > 0 && (stack[stack.length - 1]?.depth ?? 0) >= depth) stack.pop()
    if (kind === 'describe') stack.push({ title, depth })
    else paths.push([...stack.map((entry) => entry.title), title].join('-'))
  }
  return paths
}

const BROWSER_FILE = /\.browser\.test\.tsx?$/
const rel = (file: string) => relative(REPO_ROOT, file).split(sep).join('/')

const browserProjects = readProjectTestGlobs(REPO_ROOT).filter(
  (project) => project.isBrowser && project.name !== undefined,
)

/** The projects whose include/exclude globs pick this repo-relative file up. */
function owners(repoRelPath: string): ProjectGlobs[] {
  return browserProjects.filter((project) => {
    if (!repoRelPath.startsWith(`${project.dir}/`)) return false
    const inside = repoRelPath.slice(project.dir.length + 1)
    return (
      project.include.some((pattern) => testGlobMatches(pattern, inside)) &&
      !project.exclude.some((pattern) => testGlobMatches(pattern, inside))
    )
  })
}

const browserFiles = TEST_SCAN_DIRS.flatMap((dir) => listTestFiles(join(REPO_ROOT, dir))).filter(
  (file) => BROWSER_FILE.test(file),
)

describe('browser test names fit the trace attachment filename', () => {
  it('budgets each project by its own name, as measured at the boundary (self-test)', () => {
    expect(titleBudget('web-browser')).toBe(155)
    expect(titleBudget('canvas-viewer-browser')).toBe(145)
    expect(titleBudget('web-browser-window-state')).toBe(142)
  })

  it('resolves nesting and skips what cannot be measured (self-test)', () => {
    const source = [
      "describe('outer', () => {",
      "  describe('first', () => { it('a', () => {}) })",
      "  describe('second', () => { it('b', () => {}) })",
      '  it(`templated \u0024{x}`, () => {})',
      "  it('top', () => {})",
      '})',
    ].join('\n')
    expect(titlePaths(source)).toEqual(['outer-first-a', 'outer-second-b', 'outer-top'])
    expect(sanitize('導線 (a — b)')).toBe('----a---b-')
  })

  it('reaches the browser files it governs, in every browser project', () => {
    // A scan that matched nothing reads as a clean tree.
    expect(browserFiles.length).toBeGreaterThan(250)
    expect(browserProjects.map((project) => project.name).sort()).toEqual([
      'canvas-render-browser',
      'canvas-viewer-browser',
      'web-browser',
      'web-browser-window-state',
    ])
    const reached = new Set(browserFiles.flatMap((file) => owners(rel(file)).map((p) => p.name)))
    expect([...reached].sort()).toEqual(browserProjects.map((project) => project.name).sort())
  })

  it('has no browser file that no project runs', () => {
    expect(
      browserFiles.filter((file) => owners(rel(file)).length === 0).map(rel),
      'a *.browser.test file no browser project includes never runs, and its titles cannot be budgeted',
    ).toEqual([])
  })

  it('leaves no title over its own project budget, so one failure never abandons its file', () => {
    const overBudget = browserFiles
      .flatMap((file) => {
        // The tightest owner, in case a file ever lands in two projects.
        const budget = Math.min(
          ...owners(rel(file)).map((project) => titleBudget(project.name as string)),
        )
        return titlePaths(readFileSync(file, 'utf-8')).map((title) => ({
          file: rel(file),
          title,
          budget,
          length: sanitize(title).length,
        }))
      })
      .filter((entry) => entry.length > entry.budget)
      .sort((a, b) => b.length - a.length)
      .map((entry) => `${entry.length}/${entry.budget} ${entry.file}: ${entry.title}`)

    expect(
      overBudget,
      'these describe+it titles exceed their project budget, so a failure in one abandons the rest of its file',
    ).toEqual([])
  })
})
