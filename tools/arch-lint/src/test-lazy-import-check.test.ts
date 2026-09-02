/**
 * A dynamic `await import()` of a literal specifier in a test file, whether
 * inside a test body or at module scope. Each position fails differently
 * and both fail under load only.
 *
 * INSIDE a test body it charges that module graph's transform-and-load to
 * the per-test timeout — ample on an idle machine, and the first thing to
 * blow once the full suite runs every project in parallel (aggregate import
 * time there is measured in minutes). The failure names the test, not the
 * import, and reads as a mysterious load-dependent flake.
 *
 * AT MODULE SCOPE the timeout is not the problem — the request arriving
 * late is. A static import is linked before the module body runs, so it
 * cannot still be in flight when the worker's environment goes away; a
 * dynamic one is issued during evaluation and can be. Measured on CI:
 * `EnvironmentTeardownError: Cannot load '/src/server/security/
 * timing-safe.ts' ... after the environment was torn down`, on a shard
 * reporting `186 passed` files and `2121 passed` tests with `2 errors` and
 * exit 1 — every test green and the job red, which is the same unreadable
 * shape `.claude/rules/integrator-flow.md` records as its ninth.
 *
 * Hoisted to a static top-level import, neither can happen: the cost lands
 * in the collection phase no per-test timeout bounds, and the linking
 * finishes before any test does.
 *
 * A dynamic import is legitimate when the file mocks what it imports
 * (`vi.mock`/`vi.doMock`/`vi.resetModules` make evaluation order the point)
 * or when the specifier is computed (`pathToFileURL(...)` — the release
 * suites loading .mjs scripts by path). Those are recognised structurally.
 * Anything else deliberate carries a `lazy-import: <reason>` comment on the
 * line above, the same shape as an EXEMPT_FILES entry: visible, reasoned,
 * and greppable.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

const SCAN_DIRS = [
  'apps/web/src',
  'packages/model/src',
  'packages/codec/src',
  'packages/canvas-render/src',
  'packages/ports/src',
  'packages/loro-adapter/src',
  'packages/server-core/src',
  'packages/canvas-viewer/src',
  'packages/mcp-server/src',
  'tools/arch-lint/src',
] as const

/** Files whose `await import(` lives inside STRING FIXTURES, not code. */
const EXEMPT_FILES: Record<string, string> = {
  'tools/arch-lint/src/scanner.test.ts': 'the dynamic import is a scanner fixture string',
  'tools/arch-lint/src/cycle-check.test.ts': 'the dynamic import is a cycle-check fixture string',
  'tools/arch-lint/src/test-lazy-import-check.test.ts': 'this guard names the pattern it hunts',
}

/** Module-mock machinery that makes evaluation order the test's point. */
const MOCK_MACHINERY = /vi\.(mock|doMock|resetModules|unmock)\(/

/**
 * An await import of a LITERAL specifier, at any indentation.
 *
 * The leading `^\s+` this pattern used to require is why the module-scope
 * half went unseen: `const { x } = await import('./y.js')` at column 0
 * matched nothing, and seven files carried it while the guard read as
 * covering the whole shape. A position-blind matcher has no such corner —
 * the same lesson `adapter-mechanic-check` learned when its matcher read a
 * single path segment.
 *
 * Tested against each line JOINED TO THE ONE AFTER IT, because a long
 * destructure puts the specifier on its own line and a line-at-a-time
 * matcher misses that too — one more corner of the same kind, found by
 * looking for it rather than by it failing. `\s` spans the newline, so the
 * same expression covers both layouts, and a COMPUTED specifier on the next
 * line (`pathToFileURL(...)`) still does not match, which is what keeps the
 * legitimate .mjs-by-path loaders out.
 */
const LITERAL_DYNAMIC_IMPORT = /await import\(\s*(?:\/\*.*\*\/\s*)?['"`]/

const MARKER = 'lazy-import:'

function listTestFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...listTestFiles(full))
      continue
    }
    if (/\.test\.(ts|tsx)$/.test(entry.name)) files.push(full)
  }
  return files
}

function offendingLines(source: string): Array<{ line: number; text: string }> {
  if (MOCK_MACHINERY.test(source)) return []
  const lines = source.split('\n')
  const hits: Array<{ line: number; text: string }> = []
  // One marker covers a contiguous RUN of dynamic imports, and the run ends
  // at the first line that is not one. Three modules deferred past the same
  // `process.env` assignment share one reason, and repeating it on each line
  // would say less, not more — while a wider lookback would let a marker
  // excuse an import that has drifted away from it.
  let previousLineWasCovered = false
  for (const [index, line] of lines.entries()) {
    // The `await import(` has to be on THIS line: the join is only there to
    // reach a specifier that spilled onto the next one. Without this the
    // line BEFORE an import matches too, and the report names it.
    if (!line.includes('await import(')) {
      previousLineWasCovered = false
      continue
    }
    if (!LITERAL_DYNAMIC_IMPORT.test(`${line}\n${lines[index + 1] ?? ''}`)) {
      previousLineWasCovered = false
      continue
    }
    const preceding = lines.slice(Math.max(0, index - 4), index).join('\n')
    if (line.includes(MARKER) || preceding.includes(MARKER) || previousLineWasCovered) {
      previousLineWasCovered = true
      continue
    }
    previousLineWasCovered = false
    hits.push({ line: index + 1, text: line.trim() })
  }
  return hits
}

describe('literal dynamic import in test files', () => {
  it('scans a real population', () => {
    const all = SCAN_DIRS.flatMap((dir) => listTestFiles(join(REPO_ROOT, dir)))
    expect(all.length).toBeGreaterThan(300)
  })

  it('detects the shape, and honors mocks, markers, and computed paths (self-test)', () => {
    expect(
      offendingLines(`it('x', async () => {\n  const { y } = await import('./y.js')\n})`),
    ).toHaveLength(1)
    expect(
      offendingLines(
        `vi.mock('./y.js')\nit('x', async () => {\n  const { y } = await import('./y.js')\n})`,
      ),
    ).toHaveLength(0)
    expect(
      offendingLines(
        `it('x', async () => {\n  // lazy-import: identity is the subject\n  const { y } = await import('./y.js')\n})`,
      ),
    ).toHaveLength(0)
    expect(
      offendingLines(`it('x', async () => {\n  const m = await import(pathToFileURL(p).href)\n})`),
    ).toHaveLength(0)
    // Module scope: no indentation to key off, and the position the
    // `^\\s+` matcher was blind to.
    expect(offendingLines(`const { y } = await import('./y.js')`)).toHaveLength(1)
    // The specifier on its own line, which a line-at-a-time matcher misses.
    expect(offendingLines(`const {\n  y,\n} = await import(\n  './y.js',\n)`)).toEqual([
      { line: 3, text: '} = await import(' },
    ])
    // One marker covers the contiguous run below it, and stops at the first
    // line that is not a dynamic import.
    expect(
      offendingLines(
        `// lazy-import: env first\nconst a = await import('./a.js')\nconst b = await import('./b.js')\nconst c = await import('./c.js')\n\nconst d = await import('./d.js')`,
      ),
    ).toEqual([{ line: 6, text: "const d = await import('./d.js')" }])
    // Computed and split across lines: still legitimate.
    expect(offendingLines(`const m = await import(\n  pathToFileURL(p).href,\n)`)).toHaveLength(0)
  })

  it('every literal await import is mocked, marked, or hoisted', () => {
    const offenders: string[] = []
    for (const dir of SCAN_DIRS) {
      for (const file of listTestFiles(join(REPO_ROOT, dir))) {
        const relativePath = relative(REPO_ROOT, file).split(sep).join('/')
        if (relativePath in EXEMPT_FILES) continue
        for (const hit of offendingLines(readFileSync(file, 'utf-8'))) {
          offenders.push(`${relativePath}:${hit.line}: ${hit.text}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('EXEMPT_FILES entries still exist and still contain the pattern they excuse', () => {
    for (const relativePath of Object.keys(EXEMPT_FILES)) {
      if (relativePath.endsWith('test-lazy-import-check.test.ts')) continue
      const source = readFileSync(join(REPO_ROOT, relativePath), 'utf-8')
      expect(source, relativePath).toMatch(/await import\(/)
    }
  })
})
